/**
 * Live Mistral OCR client.
 *
 * Shape follows the documented endpoint: `POST https://api.mistral.ai/v1/ocr`
 * with a bearer key, `model`, and a `document` of type `document_url` (PDF) or
 * `image_url` (JPEG/PNG). Uploads are small by policy, so the bytes are sent
 * inline as a base64 data URI instead of being staged on the files API. The
 * response carries `pages[].index/markdown/dimensions/images` and `usage_info`.
 *
 * The API key comes from the `MISTRAL_API_KEY` secret binding. It is never
 * logged, never persisted, and never included in stored evidence.
 */

import { z } from "zod"

import type { AppConfig } from "../env"

import {
  OcrPageLimitError,
  OcrProviderError,
  type OcrDocument,
  type OcrPage,
  type OcrProvider,
  type OcrRegion,
  type OcrRequest,
  type SanitizedOcrResponse,
} from "./ocr"

const OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr"
const REQUEST_TIMEOUT_MS = 60_000
const PROVIDER = "mistral"

/** The document as the endpoint takes it: bytes inline, as a data URI. */
type MistralDocument =
  | { type: "document_url"; document_url: string }
  | { type: "image_url"; image_url: string }

type MistralOcrRequest = {
  model: string
  document: MistralDocument
  /** Zero-based page selector. Absent for images, which have one page. */
  pages?: string
  include_image_base64: boolean
  include_blocks: boolean
}

/**
 * The slice of the documented response this client consumes.
 *
 * `pages`, and each page's `index` and `markdown`, are what a read *is*: a
 * response without them is not a document this reader can describe, and the
 * run stops with a provider error rather than continuing on empty pages.
 * Everything around them — the echoed model name, page dimensions, located
 * image regions, usage accounting — is provenance the reader can do without,
 * so it is optional and falls back rather than failing the read.
 *
 * Unrecognised keys are dropped, which is also how the sanitized copy stays
 * free of anything the provider may add to a future response.
 */
const MISTRAL_OCR_IMAGE_SCHEMA = z.object({
  id: z.string().nullish(),
  top_left_x: z.number().nullish(),
  top_left_y: z.number().nullish(),
  bottom_right_x: z.number().nullish(),
  bottom_right_y: z.number().nullish(),
  /** Requested off, so it is normally absent; never copied onward. */
  image_base64: z.string().nullish(),
})

const MISTRAL_OCR_PAGE_SCHEMA = z.object({
  index: z.number(),
  markdown: z.string(),
  images: z.array(MISTRAL_OCR_IMAGE_SCHEMA).nullish(),
  dimensions: z
    .object({
      dpi: z.number().nullish(),
      height: z.number().nullish(),
      width: z.number().nullish(),
    })
    .nullish(),
})

const MISTRAL_OCR_RESPONSE_SCHEMA = z.object({
  model: z.string().nullish(),
  pages: z.array(MISTRAL_OCR_PAGE_SCHEMA),
  usage_info: z
    .object({
      pages_processed: z.number().nullish(),
      doc_size_bytes: z.number().nullish(),
    })
    .nullish(),
})

type MistralOcrResponse = z.infer<typeof MISTRAL_OCR_RESPONSE_SCHEMA>

type MistralOcrPage = z.infer<typeof MISTRAL_OCR_PAGE_SCHEMA>

/** The short reason a rejected request carries, when it carries one. */
const MISTRAL_ERROR_SCHEMA = z.object({ message: z.string() })

export function createMistralOcrProvider(
  config: AppConfig,
  requestFetch: typeof fetch = fetch
): OcrProvider {
  const model = config.mistralOcrModel

  return {
    name: PROVIDER,
    model,

    async read(request: OcrRequest): Promise<OcrDocument> {
      const apiKey = config.mistralApiKey
      if (!apiKey) {
        throw new OcrProviderError(
          PROVIDER,
          "The document reader is not configured for this deployment."
        )
      }

      const dataUri = `data:${request.mediaType};base64,${encodeBase64(request.bytes)}`
      const document: MistralDocument =
        request.mediaType === "application/pdf"
          ? { type: "document_url", document_url: dataUri }
          : { type: "image_url", image_url: dataUri }

      const requestBody: MistralOcrRequest = {
        model,
        document,
        include_image_base64: false,
        include_blocks: false,
      }

      if (request.mediaType === "application/pdf") {
        // Mistral page numbers are zero-based. Selecting one page beyond the
        // remaining allowance is a bounded probe: an over-limit PDF returns
        // that extra page and can be rejected instead of silently truncating,
        // while provider work stays capped at allowance + 1.
        requestBody.pages = mistralPageProbe(request.maxPages)
      }

      const startedAt = Date.now()
      let response: Response

      try {
        response = await requestFetch(OCR_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        // The cause may contain the request, so it is deliberately dropped.
        throw new OcrProviderError(
          PROVIDER,
          "The document reader did not respond in time."
        )
      }

      const latencyMs = Date.now() - startedAt

      if (!response.ok) {
        throw new OcrProviderError(
          PROVIDER,
          await readProviderMessage(response),
          response.status
        )
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new OcrProviderError(
          PROVIDER,
          "The document reader returned a response that could not be read.",
          response.status
        )
      }

      // A response this client cannot recognise ends the run as any other
      // provider failure does. Reading pages out of an unknown shape would
      // hand the workflow an empty document that looks like a real one.
      const parsed = MISTRAL_OCR_RESPONSE_SCHEMA.safeParse(payload)
      if (!parsed.success) {
        throw new OcrProviderError(
          PROVIDER,
          "The document reader returned a response in an unrecognised shape.",
          response.status
        )
      }

      const body = parsed.data

      if (exceedsPageBudget(body, request.maxPages)) {
        throw new OcrPageLimitError(PROVIDER, request.runPageLimit)
      }

      const pages = readPages(body)
      if (pages.length === 0) {
        throw new OcrProviderError(
          PROVIDER,
          "The document reader returned no readable pages.",
          response.status
        )
      }

      return {
        model: body.model ?? model,
        pages,
        usage: {
          pagesProcessed:
            readInteger(body.usage_info?.pages_processed) ?? pages.length,
          documentBytes:
            readInteger(body.usage_info?.doc_size_bytes) ??
            request.bytes.byteLength,
        },
        latencyMs,
        sanitizedResponse: sanitize(body),
      }
    },
  }
}

/**
 * Current Mistral OCR accepts a compact string of zero-based pages/ranges. The
 * last index is deliberately the one-page probe beyond the accepted count.
 */
export function mistralPageProbe(maxPages: number): string {
  const accepted = Math.max(1, Math.trunc(maxPages))
  return `0-${accepted}`
}

function exceedsPageBudget(
  body: MistralOcrResponse,
  maxPages: number
): boolean {
  const processed = readInteger(body.usage_info?.pages_processed)

  if (
    body.pages.length > maxPages ||
    (processed !== null && processed > maxPages)
  ) {
    return true
  }

  // The probe is the zero-based index equal to maxPages. Treat its presence as
  // overflow even if a usage object under-reports the page count.
  return body.pages.some((page) => Math.trunc(page.index) >= maxPages)
}

function readPages(body: MistralOcrResponse): OcrPage[] {
  return body.pages.map((page) => ({
    pageNumber: Math.trunc(page.index) + 1,
    markdown: page.markdown,
    width: readInteger(page.dimensions?.width),
    height: readInteger(page.dimensions?.height),
    dpi: readInteger(page.dimensions?.dpi),
    regions: readRegions(page),
  }))
}

function readRegions(page: MistralOcrPage): OcrRegion[] {
  return (page.images ?? []).map((image, index) => ({
    id: image.id ?? `region-${index + 1}`,
    topLeftX: readInteger(image.top_left_x) ?? 0,
    topLeftY: readInteger(image.top_left_y) ?? 0,
    bottomRightX: readInteger(image.bottom_right_x) ?? 0,
    bottomRightY: readInteger(image.bottom_right_y) ?? 0,
  }))
}

/**
 * Provider errors are reduced to a short sentence. Response headers and the
 * raw body are never propagated, because both can carry request echoes.
 */
async function readProviderMessage(response: Response): Promise<string> {
  const detail = await (async () => {
    try {
      const text = (await response.text()).slice(0, 400)
      const parsed = MISTRAL_ERROR_SCHEMA.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data.message : ""
    } catch {
      return ""
    }
  })()

  const reason = detail.replace(/\s+/g, " ").trim().slice(0, 160)

  return reason
    ? `The document reader rejected the request (${response.status}): ${reason}`
    : `The document reader rejected the request (${response.status}).`
}

/** Drops embedded image payloads so stored evidence stays small and readable. */
function sanitize(body: MistralOcrResponse): SanitizedOcrResponse {
  return {
    model: body.model ?? null,
    pages: body.pages.map((page) => ({
      index: page.index,
      markdown: page.markdown,
      images: (page.images ?? []).map((image) => ({
        id: image.id ?? null,
        top_left_x: image.top_left_x ?? null,
        top_left_y: image.top_left_y ?? null,
        bottom_right_x: image.bottom_right_x ?? null,
        bottom_right_y: image.bottom_right_y ?? null,
      })),
      dimensions: page.dimensions
        ? {
            dpi: page.dimensions.dpi ?? null,
            height: page.dimensions.height ?? null,
            width: page.dimensions.width ?? null,
          }
        : null,
    })),
    usage_info: body.usage_info
      ? {
          pages_processed: body.usage_info.pages_processed ?? null,
          doc_size_bytes: body.usage_info.doc_size_bytes ?? null,
        }
      : null,
  }
}

function readInteger(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.trunc(value)
}

function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ""

  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000))
  }

  return btoa(binary)
}
