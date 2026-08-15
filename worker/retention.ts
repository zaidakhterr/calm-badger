/**
 * Expiry.
 *
 * A public demo should forget. Curated sample runs are kept for seven days so a
 * shared link stays inspectable for a while; anything a visitor uploaded, and
 * everything derived from it, is kept for twenty-four hours. Both windows are
 * measured from the run's creation, while the equally long
 * `REVIEW_WINDOW_SECONDS_*` are measured from the moment a review opens — so a
 * live review can outlast its run's retention window by exactly the delay
 * between the two anchors. That is why the sweep defers a run whose review is
 * still pending rather than relying on the windows to line up: a run waiting on
 * a live review is never swept out from under it, and because the windows are
 * the same length the deferral is bounded by hours.
 *
 * The sweep is deliberately bounded. It takes a batch, and if there is more to
 * do it says so and leaves the rest for the next schedule rather than trying to
 * be exhaustive inside one invocation.
 *
 * Order matters. Private R2 objects are deleted before the D1 rows that point
 * at them, because the reverse order loses the pointer and orphans the bytes.
 * Those two steps cannot share a transaction, so `purge_started_at` is written
 * first: a run that still exists with that column set is a cleanup that was
 * interrupted, the next sweep takes it before anything else, and
 * `purge_attempts` and `purge_error` say how often it has failed and with what
 * kind of failure. The R2 lifecycle rule on the `runs/` prefix is the last
 * resort beneath all of that, for bytes whose D1 row is already gone.
 */

import { deleteRun } from "./runs"
import { deleteStoredSources } from "./sources"
import { pruneRateLimitWindows } from "./rate-limit"
import { CURATED_RETENTION_MS, CUSTOM_RETENTION_MS } from "./retention-policy"

/** How many runs one sweep will purge before deferring the rest. */
export const SWEEP_RUN_LIMIT = 50

/** Sweep reports older than this are pruned by the sweep itself. */
const SWEEP_HISTORY_MS = 30 * CUSTOM_RETENTION_MS

export type SweepReport = {
  id: string
  startedAt: string
  finishedAt: string
  trigger: "scheduled" | "manual"
  runsScanned: number
  runsPurged: number
  runsFailed: number
  /** Expired runs left alone because a live review still needs them. */
  runsDeferred: number
  aliasesPruned: number
  rateWindowsPruned: number
  morePending: boolean
}

type ExpiredRunRow = {
  id: string
  source_kind: string
  created_at: string
  purge_started_at: string | null
  purge_attempts: number
  review_state: string | null
  review_expires_at: string | null
}

/**
 * One bounded pass. `now` is a parameter so the windows can be driven in a test
 * by direct invocation rather than by waiting a day.
 */
export async function runRetentionSweep(
  env: Env,
  options: {
    now?: Date
    limit?: number
    trigger?: "scheduled" | "manual"
  } = {}
): Promise<SweepReport> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? SWEEP_RUN_LIMIT
  const trigger = options.trigger ?? "manual"
  const startedAt = now.toISOString()

  const candidates = await selectExpiredRuns(env, now, limit)

  let purged = 0
  let failed = 0
  let deferred = 0

  for (const run of candidates) {
    // An owner is still inside a live review window. The run's data is what
    // that decision is about, so it stays until the window closes; the review
    // window is no longer than the retention window, so what it defers by is
    // the delay before the review opened — hours at most, never forever.
    if (
      run.review_state === "pending" &&
      run.review_expires_at !== null &&
      run.review_expires_at > startedAt
    ) {
      deferred += 1
      continue
    }

    try {
      await purgeRun(env, run, startedAt)
      purged += 1
    } catch (error) {
      failed += 1
      await recordPurgeFailure(env, run.id, error)
    }
  }

  const aliasesPruned = await pruneWorkspaceAliases(env, now)
  const rateWindowsPruned = await pruneRateLimitWindows(env, now)

  const report: SweepReport = {
    id: crypto.randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger,
    runsScanned: candidates.length,
    runsPurged: purged,
    runsFailed: failed,
    runsDeferred: deferred,
    aliasesPruned,
    rateWindowsPruned,
    morePending: candidates.length >= limit,
  }

  await recordSweep(env, report)

  console.log(JSON.stringify({ event: "retention_sweep", ...report }))

  return report
}

/**
 * Expired runs, interrupted cleanups first.
 *
 * A run whose `purge_started_at` is set is selected whatever its age: its
 * artifacts are already partly gone, so finishing is the only correct move.
 */
async function selectExpiredRuns(
  env: Env,
  now: Date,
  limit: number
): Promise<ExpiredRunRow[]> {
  const curatedCutoff = new Date(
    now.getTime() - CURATED_RETENTION_MS
  ).toISOString()
  const customCutoff = new Date(
    now.getTime() - CUSTOM_RETENTION_MS
  ).toISOString()

  const rows = await env.DB.prepare(
    `SELECT runs.id,
            runs.source_kind,
            runs.created_at,
            runs.purge_started_at,
            runs.purge_attempts,
            run_reviews.state AS review_state,
            run_reviews.expires_at AS review_expires_at
       FROM runs
       LEFT JOIN run_reviews ON run_reviews.run_id = runs.id
      WHERE runs.purge_started_at IS NOT NULL
         OR (runs.source_kind = 'custom' AND runs.created_at <= ?)
         OR (runs.source_kind <> 'custom' AND runs.created_at <= ?)
      ORDER BY runs.purge_started_at IS NULL, runs.created_at ASC
      LIMIT ?`
  )
    .bind(customCutoff, curatedCutoff, limit)
    .all<ExpiredRunRow>()

  return rows.results
}

/**
 * Private bytes first, persisted state second.
 *
 * `deleteRun` is the same cascade `Start over` uses, so expiry and reset cannot
 * drift apart: it stops the durable instance — a run hibernating at review has
 * one waiting for an event that will never arrive — removes any remaining
 * originals, and deletes every run-scoped row. The explicit R2 delete before it
 * is what guarantees the ordering even if that cascade is ever reorganised.
 */
async function purgeRun(
  env: Env,
  run: ExpiredRunRow,
  startedAt: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs
        SET purge_started_at = COALESCE(purge_started_at, ?),
            purge_attempts = purge_attempts + 1,
            updated_at = ?
      WHERE id = ?`
  )
    .bind(startedAt, startedAt, run.id)
    .run()

  await deleteStoredSources(env, run.id)
  await deleteRun(env, run.id)

  console.log(
    JSON.stringify({
      event: "run_expired",
      runId: run.id,
      sourceKind: run.source_kind,
      attempt: run.purge_attempts + 1,
      resumed: run.purge_started_at !== null,
    })
  )
}

/**
 * What is left behind when a purge fails: the run row, its purge marker, the
 * attempt count, and the *name* of the failure. Never a message, which could
 * carry a key or a storage path.
 */
async function recordPurgeFailure(
  env: Env,
  runId: string,
  error: unknown
): Promise<void> {
  const name = error instanceof Error ? error.name : "unknown"

  console.error(
    JSON.stringify({ event: "run_expiry_failed", runId, error: name })
  )

  try {
    await env.DB.prepare(`UPDATE runs SET purge_error = ? WHERE id = ?`)
      .bind(name, runId)
      .run()
  } catch {
    // The database is what failed. The next sweep still finds the run through
    // its retention window.
  }
}

/** Bounded workspace memory: aliases older than the window are forgotten. */
async function pruneWorkspaceAliases(env: Env, now: Date): Promise<number> {
  const cutoff = now.toISOString()

  const result = await env.DB.prepare(
    `DELETE FROM workspace_product_aliases
      WHERE expires_at <= ?
         OR expires_at IS NULL`
  )
    .bind(cutoff)
    .run()

  return result.meta.changes ?? 0
}

async function recordSweep(env: Env, report: SweepReport): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO retention_sweeps (
         id, started_at, finished_at, trigger_kind, runs_scanned, runs_purged,
         runs_failed, runs_deferred, aliases_pruned, rate_windows_pruned,
         more_pending
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      report.id,
      report.startedAt,
      report.finishedAt,
      report.trigger,
      report.runsScanned,
      report.runsPurged,
      report.runsFailed,
      report.runsDeferred,
      report.aliasesPruned,
      report.rateWindowsPruned,
      report.morePending ? 1 : 0
    ),
    env.DB.prepare(`DELETE FROM retention_sweeps WHERE started_at <= ?`).bind(
      new Date(Date.parse(report.startedAt) - SWEEP_HISTORY_MS).toISOString()
    ),
  ])
}
