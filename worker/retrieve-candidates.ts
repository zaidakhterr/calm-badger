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

import { z } from "zod"

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
export const CANDIDATES_EVIDENCE_KIND = "candidates"

/**
 * One shortlisted product, with the rank and the evidence that put it there.
 * `source` and the line's `state` stay open strings: retrieval owns those two
 * vocabularies, and this step only records what it was handed.
 */
const RETRIEVED_CANDIDATE_SCHEMA = z.object({
  rank: z.number(),
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  manufacturer: z.string(),
  unit: z.string(),
  source: z.string(),
  score: z.number(),
  /** Why this product is in front of a reviewer at all. */
  evidence: z.string(),
  nearDuplicateOf: z.string().nullable(),
})

/** What retrieval decided about one requested line, and what it offered. */
const RETRIEVED_LINE_SCHEMA = z.object({
  position: z.number(),
  reference: z.string(),
  description: z.string(),
  query: z.string(),
  state: z.string(),
  supersededSku: z.string().nullable(),
  note: z.string(),
  candidates: z.array(RETRIEVED_CANDIDATE_SCHEMA),
})

/**
 * The evidence this step writes, and therefore owns. The projection in
 * `evidence.ts` parses stored rows with this schema rather than guessing at
 * their shape, so writer and reader cannot drift apart without the build
 * saying so.
 *
 * This step has one ending — it either retrieves or the run stops before any
 * evidence is written — so `complete` is the only state it has ever stored.
 * The lines and their candidates are the evidence itself and are required; the
 * catalogue scale and the arithmetic over the lines are shown beside them and
 * default to `null`, so a row written by an earlier build still renders.
 */
export const CANDIDATES_EVIDENCE_SCHEMA = z.object({
  state: z.literal("complete"),
  method: z.string(),
  message: z.string().nullable(),
  shortlistSize: z.number(),
  customerScoped: z.boolean(),
  catalog: z
    .object({
      activeProducts: z.number(),
      totalProducts: z.number(),
      archivedExcluded: z.number(),
    })
    .nullable()
    .catch(null),
  lines: z.array(RETRIEVED_LINE_SCHEMA),
  totals: z
    .object({
      lineCount: z.number(),
      exactCount: z.number(),
      retrievedCount: z.number(),
      candidateCount: z.number(),
      elapsedMs: z.number(),
    })
    .nullable()
    .catch(null),
})

export type CandidatesEvidence = z.infer<typeof CANDIDATES_EVIDENCE_SCHEMA>

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
    const message = "The system could not retrieve product candidates."

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
    const message = "The run does not have lines to match."
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
  await step.attachEvidence(CANDIDATES_EVIDENCE_KIND, {
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
  } satisfies CandidatesEvidence)

  await step.complete(
    `Found ${candidateCount} ${candidateCount === 1 ? "candidate" : "candidates"} for ${lines.length} ${lines.length === 1 ? "line" : "lines"}. ` +
      `Exact matches: ${exactCount}. Lines sent for ranking: ${lines.length - exactCount}.`
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
        ? "Exact evidence selected the product. The system did not use a model."
        : retrieval.state === "superseded"
          ? "The request names an old product. Its replacement is first in the shortlist. Review is required."
          : `The system searched all active products. It sends ${SHORTLIST_SIZE} products to the ranking model.`,
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
