/**
 * Turning a reranked shortlist into a product decision the workflow may trust.
 *
 * The same three gates as extraction sit between the model and anything
 * canonical: one JSON-repair attempt, the Zod schema the provider was asked to
 * constrain its response to, and a business check. Here the business check is
 * an integrity check, and it is the reason a model cannot invent a product: a
 * ranked entry survives only if its SKU was on the shortlist that was sent and
 * is an active catalogue product. Anything else is dropped, recorded as
 * rejected, and never reaches pricing.
 *
 * What survives is scored by two configurable demo heuristics — how strong the
 * winner is, and how far clear of the runner-up it is. Both are stated openly
 * in the evidence. They are not calibrated probabilities, and near-duplicate
 * products are exactly the case they exist to catch: two products that fit the
 * request equally well produce a small gap, which is a request for a human
 * rather than a confident answer.
 */

import { z } from "zod"

import {
  labelFor,
  type Confidence,
  type ConfidenceLabel,
} from "./rfq-extraction"

/** The instruction sent to the model. Static copy: no run data, no expected answers. */
export const RERANK_INSTRUCTION = [
  "You rank supplier catalogue products against one line of a customer's request for quotation.",
  "Consider only the candidate products supplied. Never propose an article number that is not in the candidate list.",
  "Judge on the stated product type, dimensions, size, material, rating, and packaging unit.",
  "When the request does not state the detail that separates two candidates, score them close together rather than guessing.",
  "Return every candidate with a score between 0 and 1 and a short reason quoting the deciding detail.",
].join(" ")

export const RERANK_SCHEMA_NAME = "catalog_rerank"

export const RERANK_SCHEMA_DESCRIPTION =
  "Candidate catalogue products ranked against one requested line, best first."

export const rerankSchema = z.object({
  ranked: z
    .array(
      z.object({
        sku: z.string().min(1).max(40),
        score: z.number(),
        reason: z.string().max(400),
      })
    )
    .max(16),
})

export type RankedCandidate = z.infer<typeof rerankSchema>["ranked"][number]

export type RerankSchemaOutcome =
  | { state: "valid"; ranked: RankedCandidate[] }
  | { state: "invalid"; issues: string[] }

/** Schema failures are reported by path and rule only: the value is model text. */
export function validateRerankOutput(value: unknown): RerankSchemaOutcome {
  const result = rerankSchema.safeParse(value)

  if (result.success) return { state: "valid", ranked: result.data.ranked }

  return {
    state: "invalid",
    issues: [
      ...new Set(
        result.error.issues.map(
          (issue) =>
            `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.code}`
        )
      ),
    ].slice(0, 10),
  }
}

/* -------------------------------------------------------------------------- */
/* Integrity                                                                  */
/* -------------------------------------------------------------------------- */

export type MatchAlternative = {
  sku: string
  name: string
  score: number
  reason: string
  /** Set when the catalogue records this product as a near duplicate. */
  nearDuplicateOf: string | null
}

export type IntegrityOutcome = {
  /** Ranked, checked, and de-duplicated. Every SKU here exists and is active. */
  kept: MatchAlternative[]
  /** What the model named that the catalogue could not support. */
  rejected: { sku: string; reason: string }[]
}

/**
 * The gate that keeps invented products out of an estimate. A ranked entry is
 * kept only when it names a product that was on the shortlist *and* is an
 * active catalogue row read back from the database.
 */
export function applyIntegrityChecks(
  ranked: RankedCandidate[],
  shortlistSkus: string[],
  activeProducts: Map<string, { name: string; nearDuplicateOf: string | null }>
): IntegrityOutcome {
  const offered = new Set(shortlistSkus)
  const kept: MatchAlternative[] = []
  const rejected: { sku: string; reason: string }[] = []
  const seen = new Set<string>()

  for (const entry of ranked) {
    const sku = entry.sku.trim().toUpperCase()

    if (seen.has(sku)) continue
    seen.add(sku)

    if (!offered.has(sku)) {
      rejected.push({
        sku,
        reason: "It was not one of the candidates sent for ranking.",
      })
      continue
    }

    const product = activeProducts.get(sku)

    if (!product) {
      rejected.push({
        sku,
        reason: "It is not an active product in the catalogue.",
      })
      continue
    }

    kept.push({
      sku,
      name: product.name,
      score: clampScore(entry.score),
      reason: entry.reason.trim(),
      nearDuplicateOf: product.nearDuplicateOf,
    })
  }

  kept.sort(
    (left, right) =>
      right.score - left.score || left.sku.localeCompare(right.sku)
  )

  return { kept, rejected }
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000
}

/* -------------------------------------------------------------------------- */
/* The acceptance heuristics                                                  */
/* -------------------------------------------------------------------------- */

export type MatchHeuristics = {
  /** How strong the winner has to be on its own. */
  winnerStrength: number
  /** How far clear of the runner-up the winner has to be. */
  winnerGap: number
}

/**
 * The winner-strength default is the same 0.55 that separates a Medium
 * confidence label from a Review one, so "accepted" and "at least Medium" mean
 * the same thing here.
 */
const DEFAULT_HEURISTICS: MatchHeuristics = {
  winnerStrength: 0.55,
  winnerGap: 0.12,
}

/**
 * Both thresholds are configured variables rather than constants, so a
 * deployment can be made stricter or looser without a code change. They are
 * demo judgement either way, and the interface says so.
 */
export function readMatchHeuristics(env: Env): MatchHeuristics {
  return {
    winnerStrength: readThreshold(
      env.MATCH_WINNER_STRENGTH,
      DEFAULT_HEURISTICS.winnerStrength
    ),
    winnerGap: readThreshold(
      env.MATCH_WINNER_GAP,
      DEFAULT_HEURISTICS.winnerGap
    ),
  }
}

function readThreshold(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "")
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback
}

export type MatchDecision = {
  state: "accepted" | "review_required"
  /**
   * The product this decision points at: canonical when the state is accepted,
   * a proposal for the reviewer when it is not, and null only when nothing
   * survived the integrity check.
   */
  sku: string | null
  /** Best first, at most three. */
  topThree: MatchAlternative[]
  winnerScore: number
  winnerGap: number
  confidence: Confidence
  reason: string
}

/**
 * The demo heuristic that decides whether a reranked line can continue without
 * a human. Deliberately simple and deliberately explained in words.
 */
export function decideMatch(
  kept: MatchAlternative[],
  heuristics: MatchHeuristics
): MatchDecision {
  const topThree = kept.slice(0, 3)
  const winner = topThree[0] ?? null
  const runnerUp = topThree[1] ?? null

  if (!winner) {
    return {
      state: "review_required",
      sku: null,
      topThree: [],
      winnerScore: 0,
      winnerGap: 0,
      confidence: {
        label: "Review",
        score: 0,
        heuristic:
          "No ranked candidate survived the catalogue integrity check, so the score stays at 0.00.",
      },
      reason:
        "No candidate the model returned is an active catalogue product from the shortlist.",
    }
  }

  const gap = Math.round((winner.score - (runnerUp?.score ?? 0)) * 1000) / 1000
  const strongEnough = winner.score >= heuristics.winnerStrength
  const clearEnough = gap >= heuristics.winnerGap
  const accepted = strongEnough && clearEnough

  const score = Math.round(winner.score * 100) / 100
  const label: ConfidenceLabel = accepted ? labelFor(score) : "Review"

  const heuristic =
    `Match confidence is a demo heuristic over two configured thresholds: the winner scores ` +
    `${winner.score.toFixed(2)} against a required ${heuristics.winnerStrength.toFixed(2)}, and leads the runner-up ` +
    `by ${gap.toFixed(2)} against a required ${heuristics.winnerGap.toFixed(2)}.`

  const reason = accepted
    ? `${winner.sku} leads the shortlist clearly enough to continue without a human.`
    : !strongEnough && !clearEnough
      ? `No candidate is convincing on its own and the leader is only ${gap.toFixed(2)} ahead.`
      : !strongEnough
        ? `The leading candidate only scores ${winner.score.toFixed(2)}.`
        : `${winner.sku} and ${runnerUp ? runnerUp.sku : "the runner-up"} are only ${gap.toFixed(2)} apart, which is too close to accept.`

  return {
    state: accepted ? "accepted" : "review_required",
    sku: winner.sku,
    topThree,
    winnerScore: winner.score,
    winnerGap: gap,
    confidence: { label, score, heuristic },
    reason,
  }
}
