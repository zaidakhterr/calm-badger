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

import type { AppConfig } from "../env"

import { createContractFakeExtractionProvider } from "./contract-fake-extraction"
import { estimateOpenRouterCostUsd } from "./openrouter-cost"
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
  /** The task instruction. Built from static copy and stored as model input. */
  instruction: string
  documents: ExtractionDocument[]
  /** Constrains the response where the provider supports structured output. */
  schema: z.ZodType
  schemaName: string
  schemaDescription: string
}

/** The two text messages supplied to the extraction model. */
export type ExtractionModelInput = {
  system: string
  user: string
}

/**
 * Renders the exact text messages the live provider sends. Keeping this beside
 * the provider contract lets the workflow persist the same input the client
 * uses without rebuilding it from evidence later.
 */
export function renderExtractionModelInput(
  request: ExtractionRequest
): ExtractionModelInput {
  const rendered = request.documents.map((document) => {
    return [
      `--- source: ${document.label} (${document.kind}), page ${document.pageNumber} ---`,
      document.markdown,
    ].join("\n")
  })

  return {
    system: request.instruction,
    user: rendered.join("\n\n"),
  }
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

/**
 * Which implementation this deployment structures requests with. The fake is
 * refused in production by the configuration schema, so the choice here is
 * between two providers rather than between a provider and a policy.
 */
export function selectExtractionProvider(
  config: AppConfig
): ExtractionProvider {
  return config.extractionProvider === "contract-fake"
    ? createContractFakeExtractionProvider(config)
    : createOpenRouterExtractionProvider(config)
}

/** Estimated spend for one extraction call. Shared with reranking. */
export function estimateExtractionCostUsd(
  config: AppConfig,
  usage: ExtractionUsage
): number | null {
  return estimateOpenRouterCostUsd(config, usage)
}
