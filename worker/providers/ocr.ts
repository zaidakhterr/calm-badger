/**
 * The document-reading seam.
 *
 * Everything downstream of this file works with `OcrDocument`, never with a
 * provider response. Two implementations exist: the live Mistral OCR client
 * (`mistral-ocr.ts`) and a deterministic contract fake (`contract-fake-ocr.ts`)
 * used by tests and fixture evaluation. Which one runs is decided by the
 * `OCR_PROVIDER` variable, so no code path silently falls back to a fake in
 * production and no test can reach the network.
 */

import { createContractFakeOcrProvider } from "./contract-fake-ocr"
import { createMistralOcrProvider } from "./mistral-ocr"

/** A single binary document handed to the provider. */
export type OcrRequest = {
  /** Stable identifier of the run source, used only for logging. */
  sourceId: string
  label: string
  mediaType: "application/pdf" | "image/jpeg" | "image/png"
  bytes: ArrayBuffer
}

/** An image region located on a page, without the image bytes themselves. */
export type OcrRegion = {
  id: string
  topLeftX: number
  topLeftY: number
  bottomRightX: number
  bottomRightY: number
}

export type OcrPage = {
  /** One-based, so page provenance reads naturally in the interface. */
  pageNumber: number
  markdown: string
  width: number | null
  height: number | null
  dpi: number | null
  regions: OcrRegion[]
}

export type OcrUsage = {
  pagesProcessed: number
  documentBytes: number | null
}

export type OcrDocument = {
  model: string
  pages: OcrPage[]
  usage: OcrUsage
  latencyMs: number
  /** Provider response with image payloads and any transport detail removed. */
  sanitizedResponse: unknown
}

export interface OcrProvider {
  readonly name: string
  readonly model: string
  read(request: OcrRequest): Promise<OcrDocument>
}

/**
 * A provider failure that is safe to show. `message` is written for a reviewer;
 * it never carries request headers, credentials, or raw provider payloads.
 */
export class OcrProviderError extends Error {
  readonly provider: string
  readonly status: number | null

  constructor(provider: string, message: string, status: number | null = null) {
    super(message)
    this.name = "OcrProviderError"
    this.provider = provider
    this.status = status
  }
}

export function selectOcrProvider(env: Env): OcrProvider {
  // Read as a plain string: tests select the fake through a binding override.
  const configured: string = env.OCR_PROVIDER

  if (configured === "contract-fake") {
    if (env.APP_ENV === "production") {
      throw new Error(
        "The contract fake OCR provider is not allowed in production"
      )
    }

    return createContractFakeOcrProvider(env)
  }

  return createMistralOcrProvider(env)
}

/**
 * Estimated spend for a document, in USD. The per-page price is a configured
 * variable rather than a constant so that it can be corrected without a code
 * change; the interface labels the result as an estimate.
 *
 * A missing or malformed price yields `null`, not zero, exactly as the token
 * price estimator does. A page that cost nothing and a page whose price was
 * never configured are different facts, and "$0.0000" for the second one would
 * be a quiet lie.
 */
export function estimateOcrCostUsd(
  env: Env,
  pagesProcessed: number
): number | null {
  const perThousand = Number.parseFloat(env.OCR_COST_PER_1000_PAGES_USD)
  if (!Number.isFinite(perThousand) || perThousand < 0) return null

  return Math.round(((pagesProcessed * perThousand) / 1000) * 1e6) / 1e6
}
