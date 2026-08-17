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

import {
  loadActiveProducts,
  loadGlobalAliases,
  type CatalogProduct,
} from "./catalog/retrieval"
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
  RerankProviderError,
  selectRerankProvider,
  type RerankProvider,
  type RerankUsage,
} from "./providers/rerank"
import { labelFor, parseModelOutput, type Confidence } from "./rfq-extraction"
import { createRunStepRecorder, type RunStepRecorder } from "./run-steps"

export const MATCH_PRODUCTS_STEP_KEY = "match-products"

const MATCHES_EVIDENCE_KIND = "matches"

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

type LineEvidence = {
  position: number
  reference: string
  description: string
  method: string
  state: string
  sku: string | null
  productName: string | null
  decisionEvidence: string
  candidateCount: number
  shortlistSize: number
  alternatives: MatchAlternative[]
  rejected: { sku: string; reason: string }[]
  confidence: Confidence
  winnerScore: number
  winnerGap: number
  repaired: boolean
  issues: string[]
  originalOutput: string | null
  latencyMs: number | null
  usage: RerankUsage | null
}

export async function matchProducts(
  env: Env,
  runId: string
): Promise<MatchProductsOutcome> {
  const step = createRunStepRecorder(env, runId, MATCH_PRODUCTS_STEP_KEY)

  try {
    return await match(env, runId, step)
  } catch (error) {
    const message = "The requested lines could not be matched."

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
    const message = "No requested lines were available to match."
    await step.fail(message)
    return { state: "error", message }
  }

  const startedAt = Date.now()
  await step.begin(
    `Ranking shortlisted products for ${lines.length} ${lines.length === 1 ? "line" : "lines"}…`
  )

  const provider = selectRerankProvider(env)
  const heuristics = readMatchHeuristics(env)
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
      evidence.push(
        await matchLine(runId, provider, heuristics, {
          line,
          shortlist,
          products,
          aliases,
        })
      )
    } catch (error) {
      const message =
        error instanceof RerankProviderError
          ? error.message
          : "The requested lines could not be matched."

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
      })

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
  })

  await step.complete(
    `Matched ${acceptedCount} ${acceptedCount === 1 ? "line" : "lines"} to catalogue products` +
      (reviewCount > 0
        ? `, ${reviewCount} needing review.`
        : " with nothing left to confirm.")
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

  const base = {
    position: line.position,
    reference: line.reference,
    description: line.description,
    candidateCount: shortlist.length,
    shortlistSize: shortlist.length,
    alternatives: [] as MatchAlternative[],
    rejected: [] as { sku: string; reason: string }[],
    repaired: false,
    issues: [] as string[],
    originalOutput: null as string | null,
    latencyMs: null as number | null,
    usage: null as RerankUsage | null,
  }

  if (!leading) {
    return {
      ...base,
      method: "none",
      state: "review_required",
      sku: null,
      productName: null,
      decisionEvidence:
        "Nothing in the active catalogue matched this wording, so there is no product to price.",
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
          ? `The request prints the current article number ${leadingProduct.sku}, which the catalogue lists as active.`
          : `The catalogue already records this wording as a name for ${leadingProduct.sku}.`,
      confidence: {
        label: "High",
        score: 1,
        heuristic:
          "Deterministic catalogue evidence, so no model judgement and no heuristic threshold was involved.",
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
      decisionEvidence: `The request names an archived product. The catalogue records ${leadingProduct.sku} as its replacement, but substituting it is a business decision, so this line waits for a human.`,
      confidence: {
        label: "Review",
        score: 0.5,
        heuristic:
          "A superseded article number always goes to review, whatever the successor scores.",
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

  const result = await provider.rerank({
    runId,
    instruction: RERANK_INSTRUCTION,
    reference: line.reference,
    description: line.description,
    candidates,
    schema: rerankSchema,
    schemaName: RERANK_SCHEMA_NAME,
    schemaDescription: RERANK_SCHEMA_DESCRIPTION,
  })

  const shared = {
    ...base,
    method: "rerank",
    shortlistSize: candidates.length,
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
      decisionEvidence: `${parsed.reason} One repair attempt was made, so this line waits for a human rather than guessing.`,
      confidence: reviewConfidence(
        "The ranking could not be read, so the score stays at 0.00."
      ),
      winnerScore: 0,
      winnerGap: 0,
    }
  }

  const checked = validateRerankOutput(parsed.value)

  if (checked.state === "invalid") {
    return {
      ...shared,
      repaired: parsed.repaired,
      issues: checked.issues,
      state: "review_required",
      sku: null,
      productName: null,
      decisionEvidence:
        "The ranking did not match the required schema, so nothing from it was used.",
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
      `${duplicate.sku} is recorded as a near duplicate of ${duplicate.nearDuplicateOf}, so the two stay close together on purpose.`
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
    note: "Demo heuristics, not calibrated probabilities. A line is accepted only when the winner clears the strength threshold and leads the runner-up by at least the gap.",
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
    estimatedCostUsd: reranked > 0 ? estimateRerankCostUsd(env, usage) : null,
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
