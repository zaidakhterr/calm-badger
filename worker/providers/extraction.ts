/**
 * The structured-extraction seam.
 *
 * Everything downstream works with `ExtractionResult`, never with a provider
 * response object. Two implementations exist: the live OpenRouter client
 * (`openrouter-extraction.ts`, driven by the Vercel AI SDK) and a deterministic
 * contract fake (`contract-fake-extraction.ts`) used by tests and fixture
 * evaluation. Which one runs is decided by the `EXTRACTION_PROVIDER` variable,
 * so no code path silently falls back to a fake in production and no test can
 * reach the network.
 *
 * The seam deliberately hands back the model's *raw text* rather than a parsed
 * object. Repair, schema validation, and business validation belong to the
 * workflow step, where they are the same code for both implementations and can
 * be tested without a provider.
 */

import type { z } from "zod"

import { createContractFakeExtractionProvider } from "./contract-fake-extraction"
import { createOpenRouterExtractionProvider } from "./openrouter-extraction"

/** One page of already-read document text handed to the model. */
export type ExtractionDocument = {
  label: string
  /** 'email_body' | 'inline_image' | 'attachment'. */
  kind: string
  pageNumber: number
  markdown: string
}

export type ExtractionRequest = {
  /** Used only for structured logging. */
  runId: string
  /** The task instruction. Built from static copy and never persisted. */
  instruction: string
  documents: ExtractionDocument[]
  /** Constrains the response where the provider supports structured output. */
  schema: z.ZodType
  schemaName: string
  schemaDescription: string
}

export type ExtractionUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type ExtractionResult = {
  model: string
  /** Model text exactly as returned, before any repair or validation. */
  text: string
  usage: ExtractionUsage
  latencyMs: number
  finishReason: string
  /** Spend the provider itself reported, when it reports one. */
  reportedCostUsd: number | null
}

export interface ExtractionProvider {
  readonly name: string
  readonly model: string
  extract(request: ExtractionRequest): Promise<ExtractionResult>
}

/**
 * A provider failure that is safe to show. `message` is written for a reviewer;
 * it never carries request headers, credentials, prompts, or raw payloads.
 */
export class ExtractionProviderError extends Error {
  readonly provider: string
  readonly status: number | null

  constructor(provider: string, message: string, status: number | null = null) {
    super(message)
    this.name = "ExtractionProviderError"
    this.provider = provider
    this.status = status
  }
}

export function selectExtractionProvider(env: Env): ExtractionProvider {
  // Read as a plain string: tests select the fake through a binding override.
  const configured: string = env.EXTRACTION_PROVIDER

  if (configured === "contract-fake") {
    if (env.APP_ENV === "production") {
      throw new Error(
        "The contract fake extraction provider is not allowed in production"
      )
    }

    return createContractFakeExtractionProvider(env)
  }

  return createOpenRouterExtractionProvider(env)
}

/**
 * Estimated spend for one extraction call, in USD. The per-million-token prices
 * are configured variables rather than constants so they can be corrected
 * without a code change; the interface labels the result as an estimate.
 *
 * A missing or malformed price yields `null`, not zero. A free call and an
 * uncosted call are different facts, and showing "$0.0000" for a deployment
 * whose prices were never configured would be a quiet lie.
 */
export function estimateExtractionCostUsd(
  env: Env,
  usage: ExtractionUsage
): number | null {
  const input = readPrice(env.OPENROUTER_COST_PER_1M_INPUT_TOKENS_USD)
  const output = readPrice(env.OPENROUTER_COST_PER_1M_OUTPUT_TOKENS_USD)

  if (input === null || output === null) return null

  const total =
    (usage.inputTokens * input) / 1e6 + (usage.outputTokens * output) / 1e6

  return Math.round(total * 1e6) / 1e6
}

function readPrice(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
