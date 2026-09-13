/**
 * The "Match products" workflow step.
 *
 * It reads what retrieval persisted and turns each requested line into one
 * decision. Three paths, in order of how much trust they need:
 *
 * 1. Deterministic evidence — an article number the request printed, or wording
 *    the catalogue records for a product — is accepted as it stands. No model
 *    is asked, so no model can overturn it.
 * 2. A request that names an archived product is proposed its live successor
 *    and sent to review. Substituting a different product is a business
 *    decision, and the demo does not make it quietly.
 * 3. Everything else sends its bounded shortlist to the configured reranker.
 *    The response survives one repair attempt, the schema, and an integrity
 *    check that the chosen SKU was on the shortlist and is an active catalogue
 *    product; then two configurable demo heuristics decide whether the winner
 *    is strong enough and far enough clear of the runner-up to continue.
 *
 * A provider failure ends the run with a short, sanitized explanation. Nothing
 * is thrown, so the durable workflow never retries a paid call and never leaves
 * this node reading `active` forever.
 */

import { startActiveObservation } from "@langfuse/tracing"
import { z } from "zod"

import {
  loadActiveProducts,
  loadGlobalAliases,
  normaliseText,
  type CatalogProduct,
} from "./catalog/retrieval"
import { readConfig } from "./env"
import { MATCH_LINE_OBSERVATION_NAME, withObservationId } from "./langfuse/ids"
import {
  applyIntegrityChecks,
  decideMatch,
  readMatchHeuristics,
  RERANK_INSTRUCTION,
  RERANK_SCHEMA_DESCRIPTION,
  RERANK_SCHEMA_NAME,
  rerankSchema,
  validateRerankOutput,
  type MatchAlternative,
  type MatchDecision,
  type MatchHeuristics,
} from "./product-matching"
import {
  estimateRerankCostUsd,
  renderRerankModelInput,
  RerankProviderError,
  selectRerankProvider,
  type RerankProvider,
} from "./providers/rerank"
import {
  CONFIDENCE_SCHEMA,
  labelFor,
  parseModelOutput,
  type Confidence,
} from "./rfq-extraction"
import { createRunStepRecorder, type RunStepRecorder } from "./run-steps"

export const MATCH_PRODUCTS_STEP_KEY = "match-products"

export const MATCHES_EVIDENCE_KIND = "matches"

/** What the reranker reported it spent on one line, or nothing. */
const RERANK_USAGE_SCHEMA = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
})

/**
 * A product this line was compared against and did not settle on. Every field
 * names something the catalogue holds, so none of them defaults.
 */
const MATCH_ALTERNATIVE_SCHEMA = z.object({
  sku: z.string(),
  name: z.string(),
  score: z.number(),
  reason: z.string(),
  /** Set when the catalogue records this product as a near duplicate. */
  nearDuplicateOf: z.string().nullable(),
})

/**
 * The `alternatives` column of `run_line_matches`, as this step stores it: the
 * same alternatives, JSON-encoded beside the decision they lost to.
 *
 * The column belongs here because this step writes it. What an unreadable one
 * means belongs to whoever reads it — the review node offers no alternatives
 * for that line, rather than refusing to open.
 */
export const STORED_MATCH_ALTERNATIVES_SCHEMA = z
  .string()
  .transform((raw, ctx) => {
    try {
      const decoded: unknown = JSON.parse(raw)
      return decoded
    } catch {
      ctx.addIssue({ code: "custom", message: "The column is not JSON text." })
      return z.NEVER
    }
  })
  .pipe(z.array(MATCH_ALTERNATIVE_SCHEMA))

/**
 * The decision for one requested line, and everything it was decided on.
 *
 * `method` and `state` stay open strings because the matching module owns
 * those two vocabularies. The confidence is required rather than defaulted:
 * unlike a latency, it is not a measurement taken alongside the decision, it
 * is the decision's own justification, and a line without one is not a line
 * this step wrote. What the provider cost and answered does default, so
 * evidence from an earlier build still renders.
 */
const MATCH_LINE_SCHEMA = z.object({
  position: z.number(),
  reference: z.string(),
  description: z.string(),
  method: z.string(),
  state: z.string(),
  sku: z.string().nullable(),
  productName: z.string().nullable(),
  decisionEvidence: z.string(),
  candidateCount: z.number(),
  shortlistSize: z.number(),
  alternatives: z.array(MATCH_ALTERNATIVE_SCHEMA),
  rejected: z.array(z.object({ sku: z.string(), reason: z.string() })),
  confidence: CONFIDENCE_SCHEMA,
  winnerScore: z.number(),
  winnerGap: z.number(),
  repaired: z.boolean(),
  issues: z.array(z.string()),
  /** Exact system and user messages supplied to the model. */
  modelInput: z
    .object({ system: z.string(), user: z.string() })
    .nullable()
    .catch(null),
  /** Model text as returned, truncated. It never held a prompt or a key. */
  originalOutput: z.string().nullable(),
  latencyMs: z.number().nullable().catch(null),
  usage: RERANK_USAGE_SCHEMA.nullable().catch(null),
})

/**
 * The evidence this step writes, and therefore owns. The projection in
 * `evidence.ts` parses stored rows with this schema rather than guessing at
 * their shape, so writer and reader cannot drift apart without the build
 * saying so.
 *
 * The decisions are the evidence and are required, down to each alternative's
 * SKU. The thresholds they were taken against and the arithmetic over them
 * default to `null`.
 */
export const MATCHES_EVIDENCE_SCHEMA = z.object({
  state: z.enum(["complete", "error"]),
  message: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  heuristics: z
    .object({
      winnerStrength: z.number(),
      winnerGap: z.number(),
      note: z.string(),
    })
    .nullable()
    .catch(null),
  lines: z.array(MATCH_LINE_SCHEMA),
  totals: z
    .object({
      lineCount: z.number(),
      acceptedCount: z.number(),
      reviewCount: z.number(),
      deterministicCount: z.number(),
      rerankedCount: z.number(),
      modelCalls: z.number(),
      providerLatencyMs: z.number(),
      usage: RERANK_USAGE_SCHEMA.nullable(),
      /** `null` when no model was called; never a silently invented zero. */
      estimatedCostUsd: z.number().nullable(),
      elapsedMs: z.number(),
    })
    .nullable()
    .catch(null),
})

export type MatchesEvidence = z.infer<typeof MATCHES_EVIDENCE_SCHEMA>

/** Model text is stored for inspection, but never unbounded. */
const MAX_STORED_OUTPUT_CHARS = 4_000

/** Retrieval sources that settle a line without any generative judgement. */
const DETERMINISTIC_SOURCES = new Set([
  "exact_sku",
  "known_alias",
  "customer_alias",
])

export type MatchProductsOutcome =
  | {
      state: "complete"
      lineCount: number
      acceptedCount: number
      reviewCount: number
      elapsedMs: number
    }
  | { state: "error"; message: string }

type LineRow = {
  position: number
  reference: string
  description: string
  validation_state: string
  validation_reason: string | null
}

type CandidateRow = {
  position: number
  sku: string
  source: string
  rank: number
  score: number
}

type LineEvidence = MatchesEvidence["lines"][number]

/**
 * What every ending of one line records regardless of what it decided: where
 * the line came from, how big its shortlist was, and what the model cost. The
 * decision itself — method, state, SKU, confidence — is added per ending.
 */
type LineEvidenceFacts = Pick<
  LineEvidence,
  | "position"
  | "reference"
  | "description"
  | "candidateCount"
  | "shortlistSize"
  | "alternatives"
  | "rejected"
  | "repaired"
  | "issues"
  | "modelInput"
  | "originalOutput"
  | "latencyMs"
  | "usage"
>

export async function matchProducts(
  env: Env,
  runId: string
): Promise<MatchProductsOutcome> {
  const step = createRunStepRecorder(env, runId, MATCH_PRODUCTS_STEP_KEY)

  try {
    return await match(env, runId, step)
  } catch (error) {
    const message = "The system could not match the lines."

    console.error(
      JSON.stringify({
        event: "match_products_failed",
        runId,
        step: MATCH_PRODUCTS_STEP_KEY,
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

async function match(
  env: Env,
  runId: string,
  step: RunStepRecorder
): Promise<MatchProductsOutcome> {
  const [lines, candidates] = await Promise.all([
    loadLines(env, runId),
    loadCandidates(env, runId),
  ])

  if (lines.length === 0) {
    const message = "The run does not have lines to match."
    await step.fail(message)
    return { state: "error", message }
  }

  const startedAt = Date.now()
  await step.begin(
    `Ranking shortlisted products for ${lines.length} ${lines.length === 1 ? "line" : "lines"}…`
  )

  const provider = selectRerankProvider(readConfig(env))
  const heuristics = readMatchHeuristics(readConfig(env))
  const skus = [...new Set(candidates.map((candidate) => candidate.sku))]
  const [products, aliases] = await Promise.all([
    loadActiveProducts(env, skus),
    loadGlobalAliases(env, skus),
  ])

  const evidence: LineEvidence[] = []

  for (const line of lines) {
    const shortlist = candidates.filter(
      (candidate) => candidate.position === line.position
    )

    try {
      // One observation per line, so the rerank generation it makes nests
      // under the line it decided, with the decision as the output.
      evidence.push(
        await withObservationId(
          runId,
          MATCH_LINE_OBSERVATION_NAME,
          line.position,
          () =>
            startActiveObservation(
              MATCH_LINE_OBSERVATION_NAME,
              async (observation) => {
                observation.update({
                  input: {
                    position: line.position,
                    reference: line.reference,
                    description: line.description,
                    shortlistSize: shortlist.length,
                  },
                })

                const matched = await matchLine(runId, provider, heuristics, {
                  line,
                  shortlist,
                  products,
                  aliases,
                })

                observation.update({
                  output: {
                    state: matched.state,
                    method: matched.method,
                    sku: matched.sku,
                    productName: matched.productName,
                    confidence: matched.confidence,
                  },
                })

                return matched
              }
            )
        )
      )
    } catch (error) {
      const message =
        error instanceof RerankProviderError
          ? error.message
          : "The system could not match the lines."

      console.error(
        JSON.stringify({
          event: "match_products_failed",
          runId,
          step: MATCH_PRODUCTS_STEP_KEY,
          provider: provider.name,
          reason: "provider",
          status: error instanceof RerankProviderError ? error.status : null,
        })
      )

      await step.attachEvidence(MATCHES_EVIDENCE_KIND, {
        state: "error",
        message,
        provider: provider.name,
        model: provider.model,
        heuristics: describeHeuristics(heuristics),
        lines: evidence,
        totals: totalsOf(evidence, env, Date.now() - startedAt),
      } satisfies MatchesEvidence)

      await step.fail(message)
      return { state: "error", message }
    }
  }

  const elapsedMs = Date.now() - startedAt
  const acceptedCount = evidence.filter(
    (entry) => entry.state === "accepted"
  ).length
  const reviewCount = evidence.length - acceptedCount

  await persistMatches(env, runId, evidence)
  await step.attachEvidence(MATCHES_EVIDENCE_KIND, {
    state: "complete",
    message: null,
    provider: provider.name,
    model: provider.model,
    heuristics: describeHeuristics(heuristics),
    lines: evidence,
    totals: totalsOf(evidence, env, elapsedMs),
  } satisfies MatchesEvidence)

  await step.complete(
    `Accepted ${acceptedCount} ${acceptedCount === 1 ? "product match" : "product matches"}. ` +
      (reviewCount > 0
        ? `Review required: ${reviewCount}.`
        : "No review is required.")
  )

  console.log(
    JSON.stringify({
      event: "match_products_completed",
      runId,
      step: MATCH_PRODUCTS_STEP_KEY,
      provider: provider.name,
      lines: lines.length,
      accepted: acceptedCount,
      review: reviewCount,
      elapsedMs,
    })
  )

  return {
    state: "complete",
    lineCount: lines.length,
    acceptedCount,
    reviewCount,
    elapsedMs,
  }
}

/* -------------------------------------------------------------------------- */
/* One line                                                                   */
/* -------------------------------------------------------------------------- */

async function matchLine(
  runId: string,
  provider: RerankProvider,
  heuristics: MatchHeuristics,
  input: {
    line: LineRow
    shortlist: CandidateRow[]
    products: Map<string, CatalogProduct>
    aliases: Map<string, string[]>
  }
): Promise<LineEvidence> {
  const { line, shortlist, products, aliases } = input
  const leading = shortlist[0] ?? null

  const base: LineEvidenceFacts = {
    position: line.position,
    reference: line.reference,
    description: line.description,
    candidateCount: shortlist.length,
    shortlistSize: shortlist.length,
    alternatives: [],
    rejected: [],
    repaired: false,
    issues: [],
    modelInput: null,
    originalOutput: null,
    latencyMs: null,
    usage: null,
  }

  if (!leading) {
    return {
      ...base,
      method: "none",
      state: "review_required",
      sku: null,
      productName: null,
      decisionEvidence: "No active product matched the request text.",
      confidence: {
        label: "Review",
        score: 0,
        heuristic:
          "Retrieval returned no candidate at all, so the score stays at 0.00.",
      },
      winnerScore: 0,
      winnerGap: 0,
    }
  }

  const leadingProduct = products.get(leading.sku) ?? null

  // 1. Deterministic evidence. Accepted as it stands, before any model.
  if (DETERMINISTIC_SOURCES.has(leading.source) && leadingProduct) {
    const method = leading.source === "exact_sku" ? "exact_sku" : "known_alias"

    return {
      ...base,
      method,
      state: "accepted",
      sku: leadingProduct.sku,
      productName: leadingProduct.name,
      decisionEvidence:
        method === "exact_sku"
          ? `The request contains active product number ${leadingProduct.sku}.`
          : `The catalogue records this text as an alias for ${leadingProduct.sku}.`,
      confidence: {
        label: "High",
        score: 1,
        heuristic:
          "Exact catalogue evidence selected this product. The system did not use a model.",
      },
      winnerScore: 1,
      winnerGap: 1,
    }
  }

  // 2. A superseded product. Its successor is a proposal, never an acceptance.
  if (leading.source === "archived_successor" && leadingProduct) {
    const alternatives = alternativesFrom(shortlist, products)

    return {
      ...base,
      method: "superseded",
      state: "review_required",
      sku: leadingProduct.sku,
      productName: leadingProduct.name,
      alternatives,
      decisionEvidence: `The request names an old product. The catalogue lists ${leadingProduct.sku} as its replacement. Review is required.`,
      confidence: {
        label: "Review",
        score: 0.5,
        heuristic: "An old product number always requires review.",
      },
      winnerScore: 0.5,
      winnerGap: 0,
    }
  }

  // 3. The bounded shortlist goes to the reranker.
  const candidates = shortlist.flatMap((candidate) => {
    const product = products.get(candidate.sku)
    if (!product) return []

    return [
      {
        sku: product.sku,
        name: product.name,
        description: product.description,
        category: product.category,
        manufacturer: product.manufacturer,
        unit: product.unit,
        knownAs: aliases.get(product.sku) ?? [],
      },
    ]
  })

  const rerankRequest = {
    runId,
    instruction: RERANK_INSTRUCTION,
    reference: line.reference,
    description: line.description,
    candidates,
    schema: rerankSchema,
    schemaName: RERANK_SCHEMA_NAME,
    schemaDescription: RERANK_SCHEMA_DESCRIPTION,
  }
  const modelInput = renderRerankModelInput(rerankRequest)
  const result = await provider.rerank(rerankRequest)

  const shared = {
    ...base,
    method: "rerank",
    shortlistSize: candidates.length,
    modelInput,
    originalOutput: result.text.slice(0, MAX_STORED_OUTPUT_CHARS),
    latencyMs: result.latencyMs,
    usage: result.usage,
  }

  const parsed = parseModelOutput(result.text)

  if (parsed.state === "irreparable") {
    return {
      ...shared,
      repaired: false,
      state: "review_required",
      sku: null,
      productName: null,
      decisionEvidence: `${parsed.reason} The system tried one repair. Review is required.`,
      confidence: reviewConfidence(
        "The ranking could not be read, so the score stays at 0.00."
      ),
      winnerScore: 0,
      winnerGap: 0,
    }
  }

  const checked = validateRerankOutput(parsed.json)

  if (checked.state === "invalid") {
    return {
      ...shared,
      repaired: parsed.repaired,
      issues: checked.issues,
      state: "review_required",
      sku: null,
      productName: null,
      decisionEvidence:
        "The ranking did not match the required schema. The system did not use it.",
      confidence: reviewConfidence(
        "The ranking failed schema validation, so the score stays at 0.00."
      ),
      winnerScore: 0,
      winnerGap: 0,
    }
  }

  const integrity = applyIntegrityChecks(
    checked.ranked,
    candidates.map((candidate) => candidate.sku),
    products
  )

  const decision = decideMatch(integrity.kept, heuristics)

  return {
    ...shared,
    repaired: parsed.repaired,
    alternatives: decision.topThree,
    rejected: integrity.rejected,
    state: decision.state,
    sku: decision.sku,
    productName: decision.topThree[0]?.name ?? null,
    decisionEvidence: describeDecision(decision, integrity.rejected),
    confidence: decision.confidence,
    winnerScore: decision.winnerScore,
    winnerGap: decision.winnerGap,
  }
}

function alternativesFrom(
  shortlist: CandidateRow[],
  products: Map<string, CatalogProduct>
): MatchAlternative[] {
  return shortlist.slice(0, 3).flatMap((candidate) => {
    const product = products.get(candidate.sku)
    if (!product) return []

    return [
      {
        sku: product.sku,
        name: product.name,
        score: candidate.score,
        reason: "Retrieved from the active catalogue.",
        nearDuplicateOf: product.nearDuplicateOf,
      },
    ]
  })
}

function describeDecision(
  decision: MatchDecision,
  rejected: { sku: string; reason: string }[]
): string {
  const duplicate = decision.topThree.find(
    (entry) => entry.nearDuplicateOf !== null
  )

  const parts = [decision.reason]

  if (duplicate) {
    parts.push(
      `${duplicate.sku} is similar to ${duplicate.nearDuplicateOf}. The system keeps their scores close.`
    )
  }

  if (rejected.length > 0) {
    parts.push(
      `${rejected.length} ranked ${rejected.length === 1 ? "entry was" : "entries were"} discarded before pricing: ${rejected
        .map((entry) => `${entry.sku} — ${entry.reason.toLowerCase()}`)
        .join("; ")}`
    )
  }

  return parts.join(" ")
}

function reviewConfidence(heuristic: string): Confidence {
  return { label: labelFor(0), score: 0, heuristic }
}

function describeHeuristics(heuristics: MatchHeuristics) {
  return {
    winnerStrength: heuristics.winnerStrength,
    winnerGap: heuristics.winnerGap,
    note: "These scores are demo rules, not probabilities. The proposed product must meet the score and score-gap limits.",
  }
}

function totalsOf(lines: LineEvidence[], env: Env, elapsedMs: number) {
  const usage = lines.reduce(
    (total, line) => ({
      inputTokens: total.inputTokens + (line.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (line.usage?.outputTokens ?? 0),
      totalTokens: total.totalTokens + (line.usage?.totalTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  )

  const reranked = lines.filter((line) => line.method === "rerank").length

  return {
    lineCount: lines.length,
    acceptedCount: lines.filter((line) => line.state === "accepted").length,
    reviewCount: lines.filter((line) => line.state !== "accepted").length,
    deterministicCount: lines.filter(
      (line) => line.method === "exact_sku" || line.method === "known_alias"
    ).length,
    rerankedCount: reranked,
    modelCalls: reranked,
    providerLatencyMs: lines.reduce(
      (total, line) => total + (line.latencyMs ?? 0),
      0
    ),
    usage: reranked > 0 ? usage : null,
    estimatedCostUsd:
      reranked > 0 ? estimateRerankCostUsd(readConfig(env), usage) : null,
    elapsedMs,
  }
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

async function loadLines(env: Env, runId: string): Promise<LineRow[]> {
  const rows = await env.DB.prepare(
    `SELECT position, reference, description, validation_state, validation_reason
       FROM run_rfq_line_items WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(runId)
    .all<LineRow>()

  return rows.results
}

async function loadCandidates(
  env: Env,
  runId: string
): Promise<CandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT position, sku, source, rank, score FROM run_line_candidates
      WHERE run_id = ? AND shortlisted = 1 ORDER BY position ASC, rank ASC`
  )
    .bind(runId)
    .all<CandidateRow>()

  return rows.results
}

async function persistMatches(
  env: Env,
  runId: string,
  lines: LineEvidence[]
): Promise<void> {
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM run_line_matches WHERE run_id = ?`).bind(runId),
  ]

  for (const line of lines) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO run_line_matches (
           id, run_id, position, state, sku, method, confidence_label,
           confidence_score, winner_gap, reason, alternatives, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        runId,
        line.position,
        line.state,
        line.sku,
        line.method,
        line.confidence.label,
        line.confidence.score,
        line.winnerGap,
        line.decisionEvidence,
        JSON.stringify(line.alternatives),
        now
      )
    )
  }

  for (let index = 0; index < statements.length; index += 200) {
    await env.DB.batch(statements.slice(index, index + 200))
  }
}

/* -------------------------------------------------------------------------- */
/* Applying a review outcome                                                  */
/* -------------------------------------------------------------------------- */

/** Which of the three offers the owner took for a line. */
export type ReviewProductDecision =
  "accepted_proposal" | "chose_alternative" | "chose_catalog"

export type ReviewProductChoice = {
  position: number
  sku: string
  decision: ReviewProductDecision
  /** The request's own wording for the line, as the alias to remember. */
  sourcePhrase: string
  /** When the remembered wording should be forgotten; null never remembers. */
  aliasExpiresAt: string | null
}

/**
 * Applies one product choice an owner made in review.
 *
 * This step owns `run_line_matches`, so it owns the correction too: review
 * hands over resolved values — a position, a SKU, which of the three offers was
 * taken — and never the columns. The workspace alias is written here for the
 * same reason: the phrase this step failed to match is the phrase worth
 * remembering, and retrieval reads it back scoped to
 * `(workspace_hash, customer_id, normalised)`.
 *
 * Everything commits in one batch, so retrieval can never observe the gap
 * between forgetting the old mapping for a phrase and recording the new one.
 * Nothing re-checks the review: the caller has already won the claim, and every
 * statement is idempotent, so a retried apply lands the same row.
 *
 * Unlike the step itself, this *does* throw — when the addressed line has no
 * match to correct, and before anything is written. The header's "nothing is
 * thrown" governs the step and its paid provider call; this runs in a durable
 * apply step instead, where a throw is the designed failure path (retry) and a
 * silent no-op would let the run record the outcome as applied while the
 * owner's choice was dropped.
 */
export async function applyReviewProductDecision(
  env: Env,
  runId: string,
  choice: ReviewProductChoice
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT position FROM run_line_matches WHERE run_id = ? AND position = ?`
  )
    .bind(runId, choice.position)
    .first<{ position: number }>()

  // Checked before the batch rather than from its result: an alias written
  // alongside a match that does not exist would outlive the failed apply.
  if (!existing) {
    throw new Error(
      `No line match at position ${choice.position} for run ${runId}.`
    )
  }

  const now = new Date().toISOString()

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE run_line_matches
          SET state = 'accepted',
              sku = ?,
              method = 'owner_review',
              confidence_label = 'High', confidence_score = 1,
              winner_gap = 1,
              reason = ?
        WHERE run_id = ? AND position = ?`
    ).bind(choice.sku, reasonFor(choice), runId, choice.position),
  ]

  const alias = await aliasStatements(env, runId, choice, now)
  statements.push(...alias)

  await env.DB.batch(statements)
}

function reasonFor(choice: ReviewProductChoice): string {
  if (choice.decision === "accepted_proposal") {
    return `The owner accepted the proposed match to ${choice.sku} during review.`
  }

  if (choice.decision === "chose_catalog") {
    return `The owner chose ${choice.sku} from the complete catalogue during review.`
  }

  return `The owner chose the alternative ${choice.sku} during review.`
}

async function aliasStatements(
  env: Env,
  runId: string,
  choice: ReviewProductChoice,
  now: string
): Promise<D1PreparedStatement[]> {
  if (!choice.aliasExpiresAt || choice.aliasExpiresAt <= now) return []

  const normalised = normaliseText(choice.sourcePhrase)
  if (normalised.length === 0) return []

  const scope = await env.DB.prepare(
    `SELECT r.workspace_hash AS workspace_hash,
            customer.customer_id AS customer_id
       FROM runs r
       LEFT JOIN run_customer_resolution customer ON customer.run_id = r.id
      WHERE r.id = ?`
  )
    .bind(runId)
    .first<{ workspace_hash: string | null; customer_id: string | null }>()

  // Remembered wording is scoped to one workspace *and* one customer, so a run
  // that resolved to nobody — or one opened without a workspace token — has
  // nowhere to file the correction. The match is still applied; only the
  // learning is skipped.
  if (!scope?.workspace_hash || !scope.customer_id) {
    console.log(
      JSON.stringify({
        event: "match_products_alias_skipped",
        runId,
        step: MATCH_PRODUCTS_STEP_KEY,
        position: choice.position,
        reason: scope?.workspace_hash ? "no_customer" : "no_workspace",
      })
    )

    return []
  }

  // The phrase is one mapping, not a history of contradictory mappings, so an
  // older SKU for the same wording goes before the correction lands.
  return [
    env.DB.prepare(
      `DELETE FROM workspace_product_aliases
        WHERE workspace_hash = ? AND customer_id = ? AND normalised = ?`
    ).bind(scope.workspace_hash, scope.customer_id, normalised),
    env.DB.prepare(
      `INSERT INTO workspace_product_aliases
         (workspace_hash, customer_id, normalised, alias, sku, created_at,
          expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_hash, customer_id, normalised, sku)
         DO UPDATE SET alias = excluded.alias,
                       created_at = excluded.created_at,
                       expires_at = excluded.expires_at`
    ).bind(
      scope.workspace_hash,
      scope.customer_id,
      normalised,
      choice.sourcePhrase,
      choice.sku,
      now,
      choice.aliasExpiresAt
    ),
  ]
}
