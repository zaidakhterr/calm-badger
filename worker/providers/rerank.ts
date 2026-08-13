/**
 * The candidate-reranking seam.
 *
 * Everything downstream works with `RerankResult`, never with a provider
 * response object. Two implementations exist: the live OpenRouter client
 * (`openrouter-rerank.ts`, driven by the Vercel AI SDK) and a deterministic
 * contract fake (`contract-fake-rerank.ts`) used by tests and fixture
 * evaluation. Which one runs is decided by the `RERANK_PROVIDER` variable, so
 * no code path silently falls back to a fake in production and no test can
 * reach the network.
 *
 * As with extraction, the seam hands back the model's *raw text*. Repair,
 * schema validation, and the integrity check that a selected product actually
 * exists and was actually on the shortlist belong to the workflow step, where
 * they are the same code for both implementations.
 *
 * What travels to the provider is only the request's own wording and the
 * catalogue text of the eight shortlisted products. The whole catalogue never
 * goes to a model, and neither does anything the demo knows about the expected
 * answer.
 */

import type { z } from "zod"

import { createContractFakeRerankProvider } from "./contract-fake-rerank"
import { estimateOpenRouterCostUsd } from "./openrouter-cost"
import { createOpenRouterRerankProvider } from "./openrouter-rerank"

/** One shortlisted product, as the model is allowed to see it. */
export type RerankCandidate = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  /**
   * The catalogue's own other names for this product. Wording private to a
   * single customer is never included.
   */
  knownAs: string[]
}

export type RerankRequest = {
  /** Used only for structured logging. */
  runId: string
  /** The task instruction. Built from static copy and never persisted. */
  instruction: string
  /** The requested line, in the request's own words. */
  reference: string
  description: string
  /** At most `SHORTLIST_SIZE` products, retrieved before the model is asked. */
  candidates: RerankCandidate[]
  schema: z.ZodType
  schemaName: string
  schemaDescription: string
}

export type RerankUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type RerankResult = {
  model: string
  /** Model text exactly as returned, before any repair or validation. */
  text: string
  usage: RerankUsage
  latencyMs: number
  finishReason: string
  /** Spend the provider itself reported, when it reports one. */
  reportedCostUsd: number | null
}

export interface RerankProvider {
  readonly name: string
  readonly model: string
  rerank(request: RerankRequest): Promise<RerankResult>
}

/**
 * A provider failure that is safe to show. `message` is written for a reviewer;
 * it never carries request headers, credentials, prompts, or raw payloads.
 */
export class RerankProviderError extends Error {
  readonly provider: string
  readonly status: number | null

  constructor(provider: string, message: string, status: number | null = null) {
    super(message)
    this.name = "RerankProviderError"
    this.provider = provider
    this.status = status
  }
}

export function selectRerankProvider(env: Env): RerankProvider {
  // Read as a plain string: tests select the fake through a binding override.
  const configured: string = env.RERANK_PROVIDER

  if (configured === "contract-fake") {
    if (env.APP_ENV === "production") {
      throw new Error(
        "The contract fake rerank provider is not allowed in production"
      )
    }

    return createContractFakeRerankProvider(env)
  }

  return createOpenRouterRerankProvider(env)
}

/** Estimated spend for one reranking call, in USD. */
export function estimateRerankCostUsd(
  env: Env,
  usage: RerankUsage
): number | null {
  return estimateOpenRouterCostUsd(env, usage)
}
