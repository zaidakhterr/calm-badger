/**
 * Deterministic contract fake for candidate reranking.
 *
 * It exists so tests and fixture evaluation can exercise the real workflow
 * without provider credentials, network access, or cost. It implements the same
 * `RerankProvider` contract as the live client and behaves like a plausible
 * reranker: it compares the request's own wording with the catalogue text of
 * the shortlist it was handed, scores each candidate by weighted lexical
 * overlap — numbers count double, because a dimension is usually what separates
 * two near-duplicate products — and writes a JSON string, exactly as a model
 * would.
 *
 * It reads nothing but the shortlist it is given. It has no access to the
 * curated scenarios, to the gold fixtures, or to the rest of the catalogue, so
 * every repair, schema, integrity, and heuristic path downstream is genuinely
 * exercised rather than short-circuited. A line whose shortlist genuinely
 * contains two equally good products produces two nearly equal scores here, and
 * the winner-gap heuristic then sends it to review on its own merits.
 *
 * `selectRerankProvider` refuses to build it when `APP_ENV` is production.
 *
 * Test hooks: a request whose wording contains one of the `trigger-…` markers
 * below produces the corresponding failure, which is how the provider, repair,
 * schema, and integrity contracts are exercised.
 */

import {
  RerankProviderError,
  type RerankCandidate,
  type RerankProvider,
  type RerankRequest,
  type RerankResult,
} from "./rerank"

const PROVIDER = "contract-fake"

const TRIGGERS = {
  providerError: "trigger-rerank-error",
  unparsable: "trigger-rerank-unparsable",
  repairable: "trigger-rerank-repairable",
  inventedSku: "trigger-rerank-invented-sku",
} as const

/** Words that carry no signal when a request is compared with a product. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "approx",
  "for",
  "of",
  "our",
  "please",
  "the",
  "to",
  "with",
])

export function createContractFakeRerankProvider(env: Env): RerankProvider {
  const model = `${env.OPENROUTER_RERANK_MODEL}-contract-fake`

  return {
    name: PROVIDER,
    model,

    rerank(request: RerankRequest): Promise<RerankResult> {
      const startedAt = Date.now()
      const wording =
        `${request.reference} ${request.description}`.toLowerCase()

      if (wording.includes(TRIGGERS.providerError)) {
        // A rejected promise, not a synchronous throw: the live client fails
        // asynchronously, and a caller that only awaits must see the same shape.
        return Promise.reject(
          new RerankProviderError(
            PROVIDER,
            "The reranking model rejected the request (503).",
            503
          )
        )
      }

      const ranked = rank(request)
      const text = renderText(ranked, wording)

      return Promise.resolve({
        model,
        text,
        usage: usageFor(request, text),
        latencyMs: Math.max(1, Date.now() - startedAt),
        finishReason: "stop",
        reportedCostUsd: null,
      })
    },
  }
}

type Ranked = { sku: string; score: number; reason: string }

function rank(request: RerankRequest): Ranked[] {
  const queryTokens = [
    ...new Set(tokenise(`${request.reference} ${request.description}`)),
  ]
  const total = queryTokens.reduce((sum, token) => sum + weight(token), 0)

  const ranked = request.candidates.map((candidate) => {
    const candidateTokens = new Set(tokenise(candidateText(candidate)))
    const shared = queryTokens.filter((token) => candidateTokens.has(token))
    const matched = shared.reduce((sum, token) => sum + weight(token), 0)

    // Numbers the product states and the request never mentioned are weak
    // evidence against it: that is usually a different size of the same thing.
    const unmatchedNumbers = [...candidateTokens].filter(
      (token) => /^\d+$/.test(token) && !queryTokens.includes(token)
    ).length

    const base = total === 0 ? 0 : matched / total
    const score = clamp(base - Math.min(0.2, unmatchedNumbers * 0.04))

    return {
      sku: candidate.sku,
      score: Math.round(score * 1000) / 1000,
      reason:
        shared.length === 0
          ? "Shares no wording with the requested line."
          : `Shares ${shared.length} of ${queryTokens.length} request terms: ${shared.slice(0, 6).join(", ")}.`,
    }
  })

  ranked.sort(
    (left, right) =>
      right.score - left.score || left.sku.localeCompare(right.sku)
  )

  return ranked
}

function candidateText(candidate: RerankCandidate): string {
  return [
    candidate.sku,
    candidate.name,
    candidate.description,
    candidate.category,
    candidate.manufacturer,
    candidate.unit,
    ...candidate.knownAs,
  ].join(" ")
}

/** A dimension usually decides between two near duplicates, so numbers count double. */
function weight(token: string): number {
  return /\d/.test(token) ? 2 : 1
}

function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * A model returns text, not an object, and not always clean text. The markers
 * reproduce the shapes the workflow has to survive: valid JSON, JSON one repair
 * attempt can rescue, output nothing can rescue, and a confident selection of a
 * product that does not exist.
 */
function renderText(ranked: Ranked[], wording: string): string {
  if (wording.includes(TRIGGERS.unparsable)) {
    return "None of the candidates look right to me, sorry."
  }

  const payload = {
    ranked: wording.includes(TRIGGERS.inventedSku)
      ? [
          {
            sku: "NX-ZZZ-9999",
            score: 0.97,
            reason: "This is exactly the product the customer means.",
          },
          ...ranked,
        ]
      : ranked,
  }

  const json = JSON.stringify(payload, null, 2)

  if (wording.includes(TRIGGERS.repairable)) {
    // A preamble, a fenced block, and a trailing comma: the usual damage.
    return `Here is the ranking:\n\n\`\`\`json\n${json.replace(/\n\}$/, ",\n}")}\n\`\`\`\n`
  }

  return json
}

/** A stable, content-derived token count so usage evidence stays reproducible. */
function usageFor(request: RerankRequest, text: string) {
  const promptChars = request.candidates.reduce(
    (total, candidate) => total + candidateText(candidate).length,
    request.reference.length + request.description.length
  )

  const inputTokens = Math.ceil(promptChars / 4)
  const outputTokens = Math.ceil(text.length / 4)

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  }
}
