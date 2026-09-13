/**
 * What the OpenRouter adapters read back from one AI SDK call.
 *
 * Extraction and reranking make the same call, through the same SDK and the
 * same provider, so the slice of a result they consume is one contract rather
 * than two: the model's text, why it stopped, the token accounting, and the
 * spend OpenRouter reports under its own provider metadata. It lives beside
 * `openrouter-cost.ts` for the same reason — the price of a call and the shape
 * of a call are both facts about the provider, not about a workflow step.
 *
 * Both adapters `safeParse` into `OpenRouterResult` and turn a result that does
 * not fit into their own provider error, so an unrecognised response ends the
 * run visibly instead of arriving downstream as empty text and zero tokens.
 */

import { z } from "zod"

/**
 * Token accounting. Every count is optional because a provider need not report
 * one and an unreported count reads as none; a count that is present but is
 * not a number does not fit this contract and fails the parse.
 */
const OPENROUTER_USAGE_SCHEMA = z.object({
  inputTokens: z.number().nullish(),
  outputTokens: z.number().nullish(),
  totalTokens: z.number().nullish(),
})

/**
 * OpenRouter's usage accounting reports credits under `openrouter.usage.cost`.
 * Every level of it is optional: accounting is switched on per request, and the
 * metadata of any other provider carries no such block at all.
 */
const OPENROUTER_METADATA_SCHEMA = z.object({
  openrouter: z
    .object({
      usage: z
        .object({ cost: z.number().nonnegative().finite().nullish() })
        .nullish(),
    })
    .nullish(),
})

export const OPENROUTER_RESULT_SCHEMA = z.object({
  /** Model text exactly as returned, before any repair or validation. */
  text: z.string(),
  finishReason: z.string(),
  usage: OPENROUTER_USAGE_SCHEMA.nullish(),
  providerMetadata: OPENROUTER_METADATA_SCHEMA.nullish(),
})

export type OpenRouterResult = z.infer<typeof OPENROUTER_RESULT_SCHEMA>

/** The totals both seams carry: `ExtractionUsage` and `RerankUsage` alike. */
export type OpenRouterTokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * Counts for the evidence the steps write. A provider that reports no total
 * has the two halves added for it, which is what a total means; a provider
 * that reports nothing at all reports zero work, not unknown work, because the
 * call did happen.
 */
export function readTokenUsage(result: OpenRouterResult): OpenRouterTokenUsage {
  const inputTokens = truncate(result.usage?.inputTokens) ?? 0
  const outputTokens = truncate(result.usage?.outputTokens) ?? 0

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      truncate(result.usage?.totalTokens) ?? inputTokens + outputTokens,
  }
}

/** Spend the provider itself reported, when it reported one. */
export function readReportedCostUsd(result: OpenRouterResult): number | null {
  return result.providerMetadata?.openrouter?.usage?.cost ?? null
}

function truncate(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.trunc(value)
}
