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

import {
  OcrProviderError,
  type OcrDocument,
  type OcrPage,
  type OcrProvider,
  type OcrRegion,
  type OcrRequest,
} from "./ocr"

const OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr"
const REQUEST_TIMEOUT_MS = 60_000
const PROVIDER = "mistral"

type MistralOcrImage = {
  id?: unknown
  top_left_x?: unknown
  top_left_y?: unknown
  bottom_right_x?: unknown
  bottom_right_y?: unknown
  image_base64?: unknown
}

type MistralOcrPage = {
  index?: unknown
  markdown?: unknown
  images?: unknown
  dimensions?: { dpi?: unknown; height?: unknown; width?: unknown } | null
}

type MistralOcrResponse = {
  model?: unknown
  pages?: unknown
  usage_info?: { pages_processed?: unknown; doc_size_bytes?: unknown } | null
}

export function createMistralOcrProvider(env: Env): OcrProvider {
  const model = env.MISTRAL_OCR_MODEL

  return {
    name: PROVIDER,
    model,

    async read(request: OcrRequest): Promise<OcrDocument> {
      const apiKey = env.MISTRAL_API_KEY?.trim()
      if (!apiKey) {
        throw new OcrProviderError(
          PROVIDER,
          "The document reader is not configured for this deployment."
        )
      }

      const dataUri = `data:${request.mediaType};base64,${encodeBase64(request.bytes)}`
      const document =
        request.mediaType === "application/pdf"
          ? { type: "document_url", document_url: dataUri }
          : { type: "image_url", image_url: dataUri }

      const startedAt = Date.now()
      let response: Response

      try {
        response = await fetch(OCR_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            document,
            include_image_base64: false,
          }),
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

      let body: MistralOcrResponse
      try {
        body = await response.json<MistralOcrResponse>()
      } catch {
        throw new OcrProviderError(
          PROVIDER,
          "The document reader returned a response that could not be read.",
          response.status
        )
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
        model: typeof body.model === "string" ? body.model : model,
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

function readPages(body: MistralOcrResponse): OcrPage[] {
  if (!Array.isArray(body.pages)) return []

  return body.pages.map((entry, index) => {
    const page = (entry ?? {}) as MistralOcrPage
    const pageIndex = readInteger(page.index)

    return {
      pageNumber: (pageIndex ?? index) + 1,
      markdown: typeof page.markdown === "string" ? page.markdown : "",
      width: readInteger(page.dimensions?.width),
      height: readInteger(page.dimensions?.height),
      dpi: readInteger(page.dimensions?.dpi),
      regions: readRegions(page.images),
    }
  })
}

function readRegions(images: unknown): OcrRegion[] {
  if (!Array.isArray(images)) return []

  return images.map((entry, index) => {
    const image = (entry ?? {}) as MistralOcrImage

    return {
      id: typeof image.id === "string" ? image.id : `region-${index + 1}`,
      topLeftX: readInteger(image.top_left_x) ?? 0,
      topLeftY: readInteger(image.top_left_y) ?? 0,
      bottomRightX: readInteger(image.bottom_right_x) ?? 0,
      bottomRightY: readInteger(image.bottom_right_y) ?? 0,
    }
  })
}

/**
 * Provider errors are reduced to a short sentence. Response headers and the
 * raw body are never propagated, because both can carry request echoes.
 */
async function readProviderMessage(response: Response): Promise<string> {
  const detail = await (async () => {
    try {
      const text = (await response.text()).slice(0, 400)
      const parsed: unknown = JSON.parse(text)
      const message = (parsed as { message?: unknown }).message
      return typeof message === "string" ? message : ""
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
function sanitize(body: MistralOcrResponse): unknown {
  const pages = Array.isArray(body.pages)
    ? body.pages.map((entry) => {
        const page = (entry ?? {}) as MistralOcrPage
        const images = Array.isArray(page.images)
          ? page.images.map((image) => {
              const { image_base64: _omitted, ...rest } = (image ??
                {}) as MistralOcrImage
              void _omitted
              return rest
            })
          : []

        return { ...page, images }
      })
    : []

  return { model: body.model, pages, usage_info: body.usage_info ?? null }
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null
}

function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ""

  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000))
  }

  return btoa(binary)
}
