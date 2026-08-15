import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { runRetentionSweep } from "../worker/retention"

/**
 * What the demo forgets, when, and in what order.
 *
 * The sweep is invoked directly with an explicit `now`, so the seven-day and
 * twenty-four-hour windows are exercised as behaviour instead of waited for.
 */

const base = "https://example.test"
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

let addressCounter = 0

/** A fresh client address per run, so retention tests never meet the limiter. */
function nextAddress(): string {
  addressCounter += 1
  return `198.51.100.${addressCounter % 250}`
}

async function createRun(scenarioId = "routine-replenishment") {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": nextAddress(),
    },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)

  const body = await response.json<{
    run: { viewId: string }
    ownerCapability: string
  }>()

  const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
    .bind(body.run.viewId)
    .first<{ id: string }>()

  return { ...body, runId: row!.id }
}

/** Backdates a run and relabels how it was started. */
async function age(runId: string, createdAt: Date, sourceKind = "curated") {
  await env.DB.prepare(
    `UPDATE runs SET created_at = ?, source_kind = ? WHERE id = ?`
  )
    .bind(createdAt.toISOString(), sourceKind, runId)
    .run()
}

function runExists(runId: string) {
  return env.DB.prepare(`SELECT id FROM runs WHERE id = ?`)
    .bind(runId)
    .first<{ id: string }>()
}

describe("retention windows", () => {
  it("keeps a sample run for seven days and an upload for twenty-four hours", async () => {
    const now = new Date()

    const freshSample = await createRun()
    const oldSample = await createRun()
    const freshUpload = await createRun()
    const oldUpload = await createRun()

    await age(freshSample.runId, new Date(now.getTime() - 6 * DAY_MS))
    await age(oldSample.runId, new Date(now.getTime() - 8 * DAY_MS))
    await age(
      freshUpload.runId,
      new Date(now.getTime() - 20 * HOUR_MS),
      "custom"
    )
    await age(oldUpload.runId, new Date(now.getTime() - 26 * HOUR_MS), "custom")

    const report = await runRetentionSweep(env, { now })

    expect(report.runsPurged).toBe(2)
    expect(await runExists(freshSample.runId)).not.toBeNull()
    expect(await runExists(freshUpload.runId)).not.toBeNull()
    expect(await runExists(oldSample.runId)).toBeNull()
    expect(await runExists(oldUpload.runId)).toBeNull()
  })

  it("deletes the private originals before the records that point at them", async () => {
    const { runId, run } = await createRun()

    const sources = await env.DB.prepare(
      `SELECT storage_key FROM run_sources WHERE run_id = ?`
    )
      .bind(runId)
      .all<{ storage_key: string }>()

    expect(sources.results.length).toBeGreaterThan(0)
    for (const source of sources.results) {
      expect(await env.ARTIFACTS.head(source.storage_key)).not.toBeNull()
    }

    await age(runId, new Date(Date.now() - 8 * DAY_MS))
    await runRetentionSweep(env, { now: new Date() })

    // Neither half is left behind: no orphaned bytes, and no row pointing at
    // bytes that are gone.
    for (const source of sources.results) {
      expect(await env.ARTIFACTS.head(source.storage_key)).toBeNull()
    }

    expect(await runExists(runId)).toBeNull()
    const steps = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM run_steps WHERE run_id = ?`
    )
      .bind(runId)
      .first<{ total: number }>()
    expect(steps?.total).toBe(0)

    const view = await exports.default.fetch(`${base}/api/runs/${run.viewId}`)
    expect(view.status).toBe(404)
  })

  it("has already removed the bytes by the time the D1 cascade runs", async () => {
    const { runId } = await createRun()

    const sources = await env.DB.prepare(
      `SELECT storage_key FROM run_sources WHERE run_id = ?`
    )
      .bind(runId)
      .all<{ storage_key: string }>()

    expect(sources.results.length).toBeGreaterThan(0)
    const keys = sources.results.map((row) => row.storage_key)

    // The end state alone cannot tell the two orders apart, so the sweep is
    // run against an environment that records what happened in what order and
    // probes R2 at the moment the cascade fires.
    const calls: string[] = []
    let headsAtFirstBatch: (boolean | null)[] = []

    const artifacts = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property)
        if (typeof value !== "function") return value

        const method = value.bind(target) as (...args: unknown[]) => unknown

        if (property !== "delete") return method

        return (...args: unknown[]) => {
          calls.push("r2:delete")
          return method(...args)
        }
      },
    })

    const db = new Proxy(env.DB, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property)
        if (typeof value !== "function") return value

        const method = value.bind(target) as (...args: unknown[]) => unknown

        if (property !== "batch") return method

        return async (...args: unknown[]) => {
          if (!calls.includes("d1:batch")) {
            headsAtFirstBatch = await Promise.all(
              keys.map(async (key) =>
                (await env.ARTIFACTS.head(key)) === null ? null : true
              )
            )
          }

          calls.push("d1:batch")
          return method(...args)
        }
      },
    })

    await age(runId, new Date(Date.now() - 8 * DAY_MS))
    await runRetentionSweep(
      { ...env, ARTIFACTS: artifacts, DB: db },
      {
        now: new Date(),
      }
    )

    // Every private object was gone before the first statement batch — the
    // cascade that deletes the rows pointing at those objects — ran.
    expect(
      calls.filter((call) => call === "r2:delete").length
    ).toBeGreaterThanOrEqual(keys.length)
    expect(calls.indexOf("r2:delete")).toBeLessThan(calls.indexOf("d1:batch"))
    expect(calls.lastIndexOf("r2:delete")).toBeLessThan(
      calls.indexOf("d1:batch")
    )
    expect(headsAtFirstBatch).toEqual(keys.map(() => null))

    expect(await runExists(runId)).toBeNull()
  })

  it("leaves an expired run alone while its owner is still inside the review window", async () => {
    const { runId } = await createRun()
    const now = new Date()

    await age(runId, new Date(now.getTime() - 8 * DAY_MS))
    await env.DB.prepare(
      `INSERT OR REPLACE INTO run_reviews
         (run_id, state, item_count, opened_at, expires_at, decided_at, summary)
       VALUES (?, 'pending', 1, ?, ?, NULL, 'one decision')`
    )
      .bind(
        runId,
        now.toISOString(),
        new Date(now.getTime() + HOUR_MS).toISOString()
      )
      .run()

    const deferredSweep = await runRetentionSweep(env, { now })
    expect(deferredSweep.runsDeferred).toBe(1)
    expect(deferredSweep.runsPurged).toBe(0)
    expect(await runExists(runId)).not.toBeNull()

    // Once that window closes there is nothing left to protect.
    const later = new Date(now.getTime() + 2 * HOUR_MS)
    const finalSweep = await runRetentionSweep(env, { now: later })
    expect(finalSweep.runsPurged).toBe(1)
    expect(await runExists(runId)).toBeNull()
  })

  it("finishes an interrupted cleanup on the next schedule", async () => {
    const { runId } = await createRun()
    const startedAt = new Date(Date.now() - HOUR_MS).toISOString()

    // What a partial cleanup leaves behind: a run that is not expired by age,
    // marked as having begun purging, with an attempt count and a failure name.
    await env.DB.prepare(
      `UPDATE runs
          SET purge_started_at = ?, purge_attempts = 1, purge_error = 'TypeError'
        WHERE id = ?`
    )
      .bind(startedAt, runId)
      .run()

    const report = await runRetentionSweep(env, { now: new Date() })

    expect(report.runsPurged).toBe(1)
    expect(await runExists(runId)).toBeNull()
  })

  it("bounds a sweep and says that more work is pending", async () => {
    const first = await createRun()
    const second = await createRun()
    const stale = new Date(Date.now() - 9 * DAY_MS)

    await age(first.runId, stale)
    await age(second.runId, stale)

    const bounded = await runRetentionSweep(env, {
      now: new Date(),
      limit: 1,
    })

    expect(bounded.runsScanned).toBe(1)
    expect(bounded.runsPurged).toBe(1)
    expect(bounded.morePending).toBe(true)

    const next = await runRetentionSweep(env, { now: new Date(), limit: 1 })
    expect(next.runsPurged).toBe(1)
    expect(await runExists(first.runId)).toBeNull()
    expect(await runExists(second.runId)).toBeNull()
  })

  it("records each sweep as counts an operator can read", async () => {
    const { runId } = await createRun()
    await age(runId, new Date(Date.now() - 9 * DAY_MS))

    const report = await runRetentionSweep(env, {
      now: new Date(),
      trigger: "scheduled",
    })

    const row = await env.DB.prepare(
      `SELECT trigger_kind, runs_scanned, runs_purged, runs_failed,
              runs_deferred, more_pending
         FROM retention_sweeps WHERE id = ?`
    )
      .bind(report.id)
      .first<Record<string, number | string>>()

    expect(row).toMatchObject({
      trigger_kind: "scheduled",
      runs_purged: report.runsPurged,
      runs_failed: 0,
    })
  })

  it("prunes expired workspace memory and spent rate-limit counters", async () => {
    const now = new Date()

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO workspace_product_aliases
           (workspace_hash, customer_id, normalised, alias, sku, created_at,
            expires_at)
         VALUES ('hash-old', 'CUST-1', 'old wording', 'old wording', 'SKU-1', ?, ?)`
      ).bind(
        new Date(now.getTime() - 2 * DAY_MS).toISOString(),
        new Date(now.getTime() - HOUR_MS).toISOString()
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO workspace_product_aliases
           (workspace_hash, customer_id, normalised, alias, sku, created_at,
            expires_at)
         VALUES ('hash-new', 'CUST-1', 'new wording', 'new wording', 'SKU-1', ?, ?)`
      ).bind(
        new Date(now.getTime() - 2 * DAY_MS).toISOString(),
        new Date(now.getTime() + 5 * DAY_MS).toISOString()
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO workspace_product_aliases
           (workspace_hash, customer_id, normalised, alias, sku, created_at,
            expires_at)
         VALUES ('hash-legacy', 'CUST-1', 'unknown origin', 'unknown origin',
                 'SKU-1', ?, NULL)`
      ).bind(now.toISOString()),
      env.DB.prepare(
        `INSERT OR REPLACE INTO rate_limit_windows
           (bucket_hash, window_start, window_end, hits)
         VALUES ('spent', ?, ?, 5)`
      ).bind(
        new Date(now.getTime() - 3 * HOUR_MS).toISOString(),
        new Date(now.getTime() - 2 * HOUR_MS).toISOString()
      ),
    ])

    const report = await runRetentionSweep(env, { now })

    expect(report.aliasesPruned).toBe(2)
    expect(report.rateWindowsPruned).toBeGreaterThanOrEqual(1)

    const remaining = await env.DB.prepare(
      `SELECT workspace_hash FROM workspace_product_aliases
        WHERE workspace_hash IN ('hash-old', 'hash-new', 'hash-legacy')`
    ).all<{ workspace_hash: string }>()

    // Workspace memory may outlive Start over, but never its source deadline.
    expect(remaining.results.map((row) => row.workspace_hash)).toEqual([
      "hash-new",
    ])
  })
})
