/**
 * The "Retrieve candidates" workflow step.
 *
 * This step exists to make the bound visible: a distributor catalogue of 250
 * products is never sent to a language model. Each requested line is either
 * settled here by deterministic evidence — an article number the request
 * printed, or wording the catalogue records as a name for a product — or
 * reduced to a shortlist of at most eight retrieved candidates. Nothing is
 * matched yet; the next step decides.
 *
 * Customer-scoped wording is only consulted when the run resolved to a
 * customer. An unresolved run is not a failure and does not stop here: it
 * simply never sees that customer's private vocabulary.
 *
 * As in the earlier steps, nothing is thrown out of this module. A throw would
 * let the durable workflow retry the step and then abandon it while it still
 * reads `active`.
 */

import {
  ensureCatalogIndexes,
  retrieveForLine,
  SHORTLIST_SIZE,
  type Candidate,
  type LineRetrieval,
} from "./catalog/retrieval"

export const RETRIEVE_CANDIDATES_STEP_KEY = "retrieve-candidates"

export type RetrieveCandidatesOutcome =
  | {
      state: "complete"
      lineCount: number
      exactCount: number
      candidateCount: number
      elapsedMs: number
    }
  | { state: "error"; message: string }

type LineRow = {
  position: number
  reference: string
  description: string
  catalog_sku: string | null
  validation_state: string
}

export async function retrieveCandidates(
  env: Env,
  runId: string
): Promise<RetrieveCandidatesOutcome> {
  try {
    return await retrieve(env, runId)
  } catch (error) {
    const message = "Catalogue candidates could not be retrieved."

    console.error(
      JSON.stringify({
        event: "retrieve_candidates_failed",
        runId,
        step: RETRIEVE_CANDIDATES_STEP_KEY,
        reason: "unexpected",
        error: error instanceof Error ? error.name : "unknown",
      })
    )

    try {
      await failStep(env, runId, message)
    } catch {
      // Nowhere left to record the failure; returning still stops the workflow.
    }

    return { state: "error", message }
  }
}

async function retrieve(
  env: Env,
  runId: string
): Promise<RetrieveCandidatesOutcome> {
  const lines = await loadLines(env, runId)

  if (lines.length === 0) {
    const message = "No requested lines were available to match."
    await failStep(env, runId, message)
    return { state: "error", message }
  }

  const startedAt = Date.now()
  await beginStep(env, runId, lines.length)
  await ensureCatalogIndexes(env)

  const customerId = await resolvedCustomerId(env, runId)
  const retrievals: { line: LineRow; retrieval: LineRetrieval }[] = []

  for (const line of lines) {
    retrievals.push({
      line,
      retrieval: await retrieveForLine(
        env,
        {
          reference: line.reference,
          description: line.description,
          catalogSku: line.catalog_sku,
        },
        customerId
      ),
    })
  }

  const elapsedMs = Date.now() - startedAt
  const exactCount = retrievals.filter(
    (entry) => entry.retrieval.state === "exact"
  ).length
  const candidateCount = retrievals.reduce(
    (total, entry) => total + countCandidates(entry.retrieval),
    0
  )

  await persistCandidates(env, runId, retrievals)
  await persistEvidence(env, runId, {
    state: "complete",
    method: "exact-evidence-then-d1-full-text",
    message: null,
    shortlistSize: SHORTLIST_SIZE,
    customerScoped: customerId !== null,
    catalog: await catalogScale(env),
    lines: retrievals.map((entry) => describeLine(entry.line, entry.retrieval)),
    totals: {
      lineCount: lines.length,
      exactCount,
      retrievedCount: lines.length - exactCount,
      candidateCount,
      elapsedMs,
    },
  })

  await completeStep(env, runId, {
    lineCount: lines.length,
    exactCount,
    candidateCount,
    elapsedMs,
  })

  console.log(
    JSON.stringify({
      event: "retrieve_candidates_completed",
      runId,
      step: RETRIEVE_CANDIDATES_STEP_KEY,
      lines: lines.length,
      exact: exactCount,
      candidates: candidateCount,
      elapsedMs,
    })
  )

  return {
    state: "complete",
    lineCount: lines.length,
    exactCount,
    candidateCount,
    elapsedMs,
  }
}

function countCandidates(retrieval: LineRetrieval): number {
  return retrieval.state === "exact" ? 1 : retrieval.shortlist.length
}

/** The evidence for one line: what settled it, or what will be reranked. */
function describeLine(line: LineRow, retrieval: LineRetrieval) {
  const shortlist =
    retrieval.state === "exact" ? [retrieval.candidate] : retrieval.shortlist

  return {
    position: line.position,
    reference: line.reference,
    description: line.description,
    query: retrieval.query,
    state: retrieval.state,
    supersededSku:
      retrieval.state === "superseded" ? retrieval.supersededSku : null,
    note:
      retrieval.state === "exact"
        ? "Settled by deterministic evidence; no model was asked."
        : retrieval.state === "superseded"
          ? "The request names an archived product, so the shortlist leads with its live successor and the line still needs a decision."
          : `Retrieved from the complete active catalogue; the top ${SHORTLIST_SIZE} go to the reranker.`,
    candidates: shortlist.map((candidate, index) => ({
      rank: index + 1,
      sku: candidate.sku,
      name: candidate.name,
      category: candidate.category,
      manufacturer: candidate.manufacturer,
      unit: candidate.unit,
      source: candidate.source,
      score: candidate.score,
      evidence: candidate.evidence,
      nearDuplicateOf: candidate.nearDuplicateOf,
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

async function loadLines(env: Env, runId: string): Promise<LineRow[]> {
  const rows = await env.DB.prepare(
    `SELECT position, reference, description, catalog_sku, validation_state
       FROM run_rfq_line_items WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(runId)
    .all<LineRow>()

  return rows.results
}

async function resolvedCustomerId(
  env: Env,
  runId: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT customer_id FROM run_customer_resolution
      WHERE run_id = ? AND state = 'resolved'`
  )
    .bind(runId)
    .first<{ customer_id: string | null }>()

  return row?.customer_id ?? null
}

async function catalogScale(env: Env) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM catalog_products WHERE status = 'active') AS active,
       (SELECT COUNT(*) FROM catalog_products) AS total`
  ).first<{ active: number; total: number }>()

  return {
    activeProducts: row?.active ?? 0,
    totalProducts: row?.total ?? 0,
    archivedExcluded: (row?.total ?? 0) - (row?.active ?? 0),
  }
}

async function persistCandidates(
  env: Env,
  runId: string,
  retrievals: { line: LineRow; retrieval: LineRetrieval }[]
): Promise<void> {
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM run_line_candidates WHERE run_id = ?`).bind(
      runId
    ),
  ]

  for (const { line, retrieval } of retrievals) {
    const candidates: Candidate[] =
      retrieval.state === "exact" ? [retrieval.candidate] : retrieval.shortlist

    candidates.forEach((candidate, index) => {
      statements.push(
        env.DB.prepare(
          `INSERT INTO run_line_candidates
             (id, run_id, position, sku, source, rank, score, shortlisted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          runId,
          line.position,
          candidate.sku,
          candidate.source,
          index + 1,
          candidate.score,
          1,
          now
        )
      )
    })
  }

  for (let index = 0; index < statements.length; index += 200) {
    await env.DB.batch(statements.slice(index, index + 200))
  }
}

async function beginStep(
  env: Env,
  runId: string,
  lineCount: number
): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'active',
              summary = ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
        WHERE run_id = ? AND step_key = ?`
    ).bind(
      `Searching the catalogue for ${lineCount} requested ${lineCount === 1 ? "line" : "lines"}…`,
      now,
      now,
      runId,
      RETRIEVE_CANDIDATES_STEP_KEY
    ),
    env.DB.prepare(
      `UPDATE runs SET workflow_state = 'retrieving_candidates', updated_at = ?
        WHERE id = ?`
    ).bind(now, runId),
  ])
}

async function completeStep(
  env: Env,
  runId: string,
  totals: {
    lineCount: number
    exactCount: number
    candidateCount: number
    elapsedMs: number
  }
): Promise<void> {
  const now = new Date().toISOString()
  const retrieved = totals.lineCount - totals.exactCount
  const summary =
    `Retrieved ${totals.candidateCount} ${totals.candidateCount === 1 ? "candidate" : "candidates"} ` +
    `for ${totals.lineCount} ${totals.lineCount === 1 ? "line" : "lines"}: ` +
    `${totals.exactCount} settled by exact evidence, ` +
    `${retrieved} shortlisted for reranking.`

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'complete', summary = ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ?`
    ).bind(summary, now, now, runId, RETRIEVE_CANDIDATES_STEP_KEY),
    env.DB.prepare(
      `UPDATE runs SET workflow_state = 'candidates_retrieved', updated_at = ?
        WHERE id = ?`
    ).bind(now, runId),
  ])
}

async function failStep(
  env: Env,
  runId: string,
  message: string
): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'error', summary = ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ?`
    ).bind(message, now, now, runId, RETRIEVE_CANDIDATES_STEP_KEY),
    env.DB.prepare(
      `UPDATE runs SET status = 'error', workflow_state = 'failed', updated_at = ?
        WHERE id = ?`
    ).bind(now, runId),
  ])
}

async function persistEvidence(
  env: Env,
  runId: string,
  payload: unknown
): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO run_step_evidence (id, run_id, step_key, kind, payload, created_at)
     VALUES (?, ?, ?, 'candidates', ?, ?)
     ON CONFLICT (run_id, step_key, kind) DO UPDATE SET
       payload = excluded.payload,
       created_at = excluded.created_at`
  )
    .bind(
      crypto.randomUUID(),
      runId,
      RETRIEVE_CANDIDATES_STEP_KEY,
      JSON.stringify(payload),
      now
    )
    .run()
}
