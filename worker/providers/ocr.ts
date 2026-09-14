/**
 * The document-reading seam.
 *
 * Everything downstream of this file works with `OcrDocument`, never with a
 * provider response. Two implementations exist: the live Mistral OCR client
 * (`mistral-ocr.ts`) and a deterministic contract fake (`contract-fake-ocr.ts`)
 * used by tests. Which one runs is decided by the
 * `OCR_PROVIDER` variable, so no code path silently falls back to a fake in
 * production and no test can reach the network.
 */

import { z } from "zod"

import type { AppConfig } from "../env"

import { createContractFakeOcrProvider } from "./contract-fake-ocr"
import { createMistralOcrProvider } from "./mistral-ocr"

/** A single binary document handed to the provider. */
export type OcrRequest = {
  /** Stable identifier of the run source, used only for logging. */
  sourceId: string
  label: string
  mediaType: "application/pdf" | "image/jpeg" | "image/png"
  bytes: ArrayBuffer
  /** Pages this source may consume from the run's remaining OCR allowance. */
  maxPages: number
  /** Public total, carried so every provider can explain the same boundary. */
  runPageLimit: number
}

/** An image region located on a page, without the image bytes themselves. */
export const OCR_REGION_SCHEMA = z.object({
  id: z.string(),
  topLeftX: z.number(),
  topLeftY: z.number(),
  bottomRightX: z.number(),
  bottomRightY: z.number(),
})

export type OcrRegion = z.infer<typeof OCR_REGION_SCHEMA>

/**
 * One page's regions as `run_source_pages.regions` stores them: this contract's
 * own array, JSON-encoded by the step that persists the page.
 *
 * The column belongs to this seam rather than to the reader, because these are
 * the regions a provider reported. Whoever reads the column decides what an
 * unreadable one means; regions are provenance around a page of text, so the
 * projection treats them as enrichment and shows none.
 */
export const STORED_OCR_REGIONS_SCHEMA = z
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
  .pipe(z.array(OCR_REGION_SCHEMA))

/**
 * The provider response as evidence keeps it: image payloads removed.
 *
 * The shape follows Mistral's documented OCR response — `model`, `pages[]` with
 * `index`, `markdown`, `images`, and `dimensions`, and `usage_info` — because
 * that is what the live reader answers with and what the contract fake
 * imitates. It lives here rather than in either implementation because both
 * write it and the interface renders it verbatim, so the two must agree.
 *
 * Image bytes never appear: `image_base64` is dropped before this value is
 * built, so stored evidence stays small and carries no document content beyond
 * the text and the regions the provider located.
 */
export const SANITIZED_OCR_IMAGE_SCHEMA = z.object({
  id: z.string().nullable(),
  top_left_x: z.number().nullable(),
  top_left_y: z.number().nullable(),
  bottom_right_x: z.number().nullable(),
  bottom_right_y: z.number().nullable(),
})

export const SANITIZED_OCR_RESPONSE_SCHEMA = z.object({
  model: z.string().nullable(),
  pages: z.array(
    z.object({
      /** Zero-based, as the provider numbers its own pages. */
      index: z.number(),
      markdown: z.string(),
      images: z.array(SANITIZED_OCR_IMAGE_SCHEMA),
      dimensions: z
        .object({
          dpi: z.number().nullable(),
          height: z.number().nullable(),
          width: z.number().nullable(),
        })
        .nullable(),
    })
  ),
  usage_info: z
    .object({
      pages_processed: z.number().nullable(),
      doc_size_bytes: z.number().nullable(),
    })
    .nullable(),
})

export type SanitizedOcrResponse = z.infer<typeof SANITIZED_OCR_RESPONSE_SCHEMA>

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
  /**
   * Provider response with image payloads and any transport detail removed.
   * Null when no provider was asked: the email body is text already.
   */
  sanitizedResponse: SanitizedOcrResponse | null
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

/** A safe, actionable terminal result for a document over the public budget. */
export class OcrPageLimitError extends OcrProviderError {
  readonly limit: number

  constructor(provider: string, limit: number) {
    super(
      provider,
      `This public demo can read at most ${limit} PDF or image pages in one run. Remove or split the attachments and start a new run.`
    )
    this.name = "OcrPageLimitError"
    this.limit = limit
  }
}

/**
 * Which implementation this deployment reads documents with. The fake is
 * refused in production by the configuration schema, so the choice here is
 * between two providers rather than between a provider and a policy.
 */
export function selectOcrProvider(config: AppConfig): OcrProvider {
  return config.ocrProvider === "contract-fake"
    ? createContractFakeOcrProvider(config)
    : createMistralOcrProvider(config)
}
