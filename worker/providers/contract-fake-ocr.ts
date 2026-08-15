/**
 * Deterministic contract fake for document reading.
 *
 * It exists so tests and fixture evaluation can exercise the real workflow
 * without provider credentials, network access, or cost. It implements the same
 * `OcrProvider` contract as the live client and produces output derived only
 * from the submitted bytes: no expected answer, no recorded provider response,
 * and nothing scenario-specific. `selectOcrProvider` refuses to build it when
 * `APP_ENV` is production, so it can never stand in for the live reader.
 *
 * Text-drawing PDFs are read from their content stream, which is enough for the
 * curated attachments and for any simple uploaded PDF. Images cannot be read
 * without a model, so they yield a described page and one full-page region.
 *
 * Test hook: a source labelled `trigger-provider-error` fails with a terminal
 * provider error, which is how the failure contract is exercised.
 */

import {
  OcrPageLimitError,
  OcrProviderError,
  type OcrDocument,
  type OcrPage,
  type OcrProvider,
  type OcrRequest,
} from "./ocr"

const PROVIDER = "contract-fake"
const FAILURE_LABEL = "trigger-provider-error"

export function createContractFakeOcrProvider(env: Env): OcrProvider {
  const model = `${env.MISTRAL_OCR_MODEL}-contract-fake`

  return {
    name: PROVIDER,
    model,

    read(request: OcrRequest): Promise<OcrDocument> {
      const startedAt = Date.now()

      if (request.label.includes(FAILURE_LABEL)) {
        throw new OcrProviderError(
          PROVIDER,
          "The document reader rejected the request (502): upstream document service unavailable.",
          502
        )
      }

      const pages =
        request.mediaType === "application/pdf"
          ? readPdfPages(request)
          : [describeImage(request)]

      return Promise.resolve({
        model,
        pages,
        usage: {
          pagesProcessed: pages.length,
          documentBytes: request.bytes.byteLength,
        },
        latencyMs: Math.max(1, Date.now() - startedAt),
        sanitizedResponse: {
          model,
          pages: pages.map((page) => ({
            index: page.pageNumber - 1,
            markdown: page.markdown,
            images: page.regions,
            dimensions: {
              dpi: page.dpi,
              height: page.height,
              width: page.width,
            },
          })),
          usage_info: {
            pages_processed: pages.length,
            doc_size_bytes: request.bytes.byteLength,
          },
        },
      })
    },
  }
}

/** Reads the literal strings a simple text PDF draws with `Tj`. */
function readPdfPages(request: OcrRequest): OcrPage[] {
  const raw = decodeLatin1(request.bytes)
  const lines: string[] = []
  const pageCount = Math.max(
    1,
    Array.from(raw.matchAll(/\/Type\s*\/Page\b/g)).length
  )

  if (pageCount > request.maxPages) {
    throw new OcrPageLimitError(PROVIDER, request.runPageLimit)
  }

  for (const match of raw.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)) {
    lines.push(
      match[1]
        .replaceAll("\\(", "(")
        .replaceAll("\\)", ")")
        .replaceAll("\\\\", "\\")
    )
  }

  const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+(\d+)\s+(\d+)\s*\]/.exec(raw)
  const markdown = lines.length
    ? lines.join("\n")
    : `Document ${request.label} contained no readable text layer (${contentFingerprint(request.bytes)}).`

  return Array.from({ length: pageCount }, (_, index) => ({
    pageNumber: index + 1,
    markdown,
    width: mediaBox ? Number.parseInt(mediaBox[1], 10) : null,
    height: mediaBox ? Number.parseInt(mediaBox[2], 10) : null,
    dpi: 72,
    regions: [],
  }))
}

function describeImage(request: OcrRequest): OcrPage {
  const size = readPngSize(request.bytes)

  return {
    pageNumber: 1,
    markdown: `![${request.label}](${request.label})\n\nImage source ${request.label} (${contentFingerprint(request.bytes)}).`,
    width: size?.width ?? null,
    height: size?.height ?? null,
    dpi: 72,
    regions: [
      {
        id: "region-1",
        topLeftX: 0,
        topLeftY: 0,
        bottomRightX: size?.width ?? 0,
        bottomRightY: size?.height ?? 0,
      },
    ],
  }
}

function readPngSize(
  bytes: ArrayBuffer
): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null

  const view = new DataView(bytes)
  // PNG signature, then the IHDR width/height at byte 16.
  if (view.getUint32(0) !== 0x89504e47) return null

  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Stable, content-derived label so fake output is reproducible and traceable. */
function contentFingerprint(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let hash = 0x811c9dc5

  for (const byte of view) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `sha-free fingerprint ${hash.toString(16).padStart(8, "0")}`
}

function decodeLatin1(bytes: ArrayBuffer): string {
  return new TextDecoder("latin1").decode(bytes)
}
