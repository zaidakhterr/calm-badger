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
import { createRunStepRecorder, type RunStepRecorder } from "./run-steps"

export const RETRIEVE_CANDIDATES_STEP_KEY = "retrieve-candidates"

/** The evidence this step attaches to itself. */
const EVIDENCE_KIND = "candidates"

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
  const step = createRunStepRecorder(env, runId, RETRIEVE_CANDIDATES_STEP_KEY)

  try {
    return await retrieve(env, runId, step)
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
      await step.fail(message)
    } catch {
      // Nowhere left to record the failure; returning still stops the workflow.
    }

    return { state: "error", message }
  }
}

async function retrieve(
  env: Env,
  runId: string,
  step: RunStepRecorder
): Promise<RetrieveCandidatesOutcome> {
  const lines = await loadLines(env, runId)

  if (lines.length === 0) {
    const message = "No requested lines were available to match."
    await step.fail(message)
    return { state: "error", message }
  }

  const startedAt = Date.now()
  await step.begin(
    `Searching the catalogue for ${lines.length} requested ${lines.length === 1 ? "line" : "lines"}…`
  )
  await ensureCatalogIndexes(env)

  const customerId = await resolvedCustomerId(env, runId)
  const workspaceHash = await runWorkspaceHash(env, runId)
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
        { customerId, workspaceHash }
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
  await step.attachEvidence(EVIDENCE_KIND, {
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

  await step.complete(
    `Retrieved ${candidateCount} ${candidateCount === 1 ? "candidate" : "candidates"} ` +
      `for ${lines.length} ${lines.length === 1 ? "line" : "lines"}: ` +
      `${exactCount} settled by exact evidence, ` +
      `${lines.length - exactCount} shortlisted for reranking.`
  )

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

/**
 * The browser workspace this run belongs to, if any. It unlocks nothing except
 * wording that same workspace confirmed in an earlier review.
 */
async function runWorkspaceHash(
  env: Env,
  runId: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT workspace_hash FROM runs WHERE id = ?`
  )
    .bind(runId)
    .first<{ workspace_hash: string | null }>()

  return row?.workspace_hash ?? null
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
