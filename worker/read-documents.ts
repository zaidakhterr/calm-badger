/**
 * The "Read documents" workflow step.
 *
 * Each stored source is read once: the email body is text already, and every
 * binary source goes through the configured OCR provider. Page text is written
 * with its provenance (source, page number, image regions) so a later step can
 * say where a fact came from, and the step's sanitized provider evidence is
 * persisted for the interface.
 *
 * A provider failure ends the run: the step becomes a terminal error with a
 * short, sanitized explanation, and the graph stops instead of staying active.
 * Every other failure — a misconfigured provider, a database hiccup — is caught
 * by the same outer boundary, so the step can never be abandoned mid-flight.
 */

import {
  estimateOcrCostUsd,
  OcrPageLimitError,
  OcrProviderError,
  selectOcrProvider,
  type OcrDocument,
  type OcrPage,
} from "./providers/ocr"
import { createRunStepRecorder, type RunStepRecorder } from "./run-steps"
import {
  loadSources,
  MAX_OCR_PAGES_PER_RUN,
  type StoredSource,
} from "./sources"

export const READ_DOCUMENTS_STEP_KEY = "read-documents"

/** The one kind of evidence this step attaches. */
const DOCUMENTS_EVIDENCE_KIND = "documents"

type SourceEvidence = {
  sourceId: string
  label: string
  kind: string
  mediaType: string
  byteSize: number
  /** How the text was obtained: the email body needs no provider. */
  reader: "email-body" | "ocr-provider"
  pageCount: number
  pagesProcessed: number
  latencyMs: number
  /** `null` when the configured page price is missing or malformed. */
  estimatedCostUsd: number | null
  sanitizedResponse: unknown
}

export type ReadDocumentsOutcome =
  | {
      state: "complete"
      sourceCount: number
      pageCount: number
      elapsedMs: number
    }
  | { state: "error"; message: string }
  | { state: "skipped" }

/**
 * Reads every source of a run. Nothing is thrown: a provider failure and any
 * unexpected failure both end as a terminal error on the step and on the run,
 * because a throw would let the workflow retry a paid call and then abandon the
 * step while it still reads `active`.
 */
export async function readDocuments(
  env: Env,
  runId: string
): Promise<ReadDocumentsOutcome> {
  const recorder = createRunStepRecorder(env, runId, READ_DOCUMENTS_STEP_KEY)

  try {
    return await readAllSources(env, runId, recorder)
  } catch (error) {
    const message = "The documents could not be read."

    console.error(
      JSON.stringify({
        event: "read_documents_failed",
        runId,
        step: READ_DOCUMENTS_STEP_KEY,
        reason: "unexpected",
        error: error instanceof Error ? error.name : "unknown",
      })
    )

    try {
      await recorder.fail(message)
    } catch {
      // The database itself is unreachable, so there is nowhere left to record
      // the failure. Returning still stops the workflow rather than retrying.
    }

    return { state: "error", message }
  }
}

async function readAllSources(
  env: Env,
  runId: string,
  recorder: RunStepRecorder
): Promise<ReadDocumentsOutcome> {
  const sources = await loadSources(env, runId)

  if (sources.length === 0) {
    await recorder.fail("No source documents were stored for this run.")
    return { state: "error", message: "No source documents were stored" }
  }

  const startedAt = Date.now()
  await recorder.begin(
    `Reading ${sources.length} ${sources.length === 1 ? "source" : "sources"}…`
  )

  const provider = selectOcrProvider(env)
  const evidence: SourceEvidence[] = []
  const pageRows: { source: StoredSource; page: OcrPage }[] = []
  let ocrPagesUsed = 0

  for (const source of sources) {
    try {
      const read = await readSource(
        env,
        provider,
        source,
        MAX_OCR_PAGES_PER_RUN - ocrPagesUsed
      )

      for (const page of read.document.pages) {
        pageRows.push({ source, page })
      }

      if (read.evidence.reader === "ocr-provider") {
        // Treat a returned page as consumed even if usage metadata under-reports
        // it. The provider contract separately rejects either measure above the
        // allowance, so the aggregate can never silently drift past the cap.
        ocrPagesUsed += Math.max(
          read.document.pages.length,
          read.document.usage.pagesProcessed
        )
      }

      evidence.push(read.evidence)
    } catch (error) {
      const message =
        error instanceof OcrProviderError
          ? error.message
          : "The documents could not be read."

      console.error(
        JSON.stringify({
          event: "read_documents_failed",
          runId,
          step: READ_DOCUMENTS_STEP_KEY,
          provider: provider.name,
          status: error instanceof OcrProviderError ? error.status : null,
        })
      )

      await recorder.attachEvidence(DOCUMENTS_EVIDENCE_KIND, {
        provider: provider.name,
        model: provider.model,
        state: "error",
        message,
        sources: evidence,
        totals: totalsOf(evidence, Date.now() - startedAt),
      })

      await recorder.fail(message)

      return { state: "error", message }
    }
  }

  const elapsedMs = Date.now() - startedAt

  await persistPages(env, runId, pageRows)
  await recorder.attachEvidence(DOCUMENTS_EVIDENCE_KIND, {
    provider: provider.name,
    model: provider.model,
    state: "complete",
    message: null,
    sources: evidence,
    totals: totalsOf(evidence, elapsedMs),
  })

  await recorder.complete(
    `Read ${sources.length} ${sources.length === 1 ? "source" : "sources"} ` +
      `into ${pageRows.length} ${pageRows.length === 1 ? "page" : "pages"} ` +
      `in ${formatSeconds(elapsedMs)}.`
  )

  console.log(
    JSON.stringify({
      event: "read_documents_completed",
      runId,
      step: READ_DOCUMENTS_STEP_KEY,
      provider: provider.name,
      sources: sources.length,
      pages: pageRows.length,
      elapsedMs,
    })
  )

  return {
    state: "complete",
    sourceCount: sources.length,
    pageCount: pageRows.length,
    elapsedMs,
  }
}

async function readSource(
  env: Env,
  provider: ReturnType<typeof selectOcrProvider>,
  source: StoredSource,
  maxPages: number
): Promise<{ document: OcrDocument; evidence: SourceEvidence }> {
  const object = await env.ARTIFACTS.get(source.storageKey)

  if (!object) {
    throw new OcrProviderError(
      provider.name,
      `The stored source ${source.label} is no longer available.`
    )
  }

  const bytes = await object.arrayBuffer()

  if (source.mediaType === "text/plain") {
    const text = new TextDecoder().decode(bytes)
    const document: OcrDocument = {
      model: "none",
      pages: [
        {
          pageNumber: 1,
          markdown: text,
          width: null,
          height: null,
          dpi: null,
          regions: [],
        },
      ],
      usage: { pagesProcessed: 0, documentBytes: bytes.byteLength },
      latencyMs: 0,
      sanitizedResponse: null,
    }

    return {
      document,
      evidence: {
        sourceId: source.id,
        label: source.label,
        kind: source.kind,
        mediaType: source.mediaType,
        byteSize: source.byteSize,
        reader: "email-body",
        pageCount: 1,
        pagesProcessed: 0,
        latencyMs: 0,
        estimatedCostUsd: 0,
        sanitizedResponse: null,
      },
    }
  }

  if (maxPages < 1) {
    throw new OcrPageLimitError(provider.name, MAX_OCR_PAGES_PER_RUN)
  }

  const document = await provider.read({
    sourceId: source.id,
    label: source.label,
    mediaType: source.mediaType as
      "application/pdf" | "image/jpeg" | "image/png",
    bytes,
    maxPages,
    runPageLimit: MAX_OCR_PAGES_PER_RUN,
  })

  if (
    document.pages.length > maxPages ||
    document.usage.pagesProcessed > maxPages
  ) {
    throw new OcrPageLimitError(provider.name, MAX_OCR_PAGES_PER_RUN)
  }

  return {
    document,
    evidence: {
      sourceId: source.id,
      label: source.label,
      kind: source.kind,
      mediaType: source.mediaType,
      byteSize: source.byteSize,
      reader: "ocr-provider",
      pageCount: document.pages.length,
      pagesProcessed: document.usage.pagesProcessed,
      latencyMs: document.latencyMs,
      estimatedCostUsd: estimateOcrCostUsd(env, document.usage.pagesProcessed),
      sanitizedResponse: document.sanitizedResponse,
    },
  }
}

function totalsOf(sources: SourceEvidence[], elapsedMs: number) {
  return {
    sourceCount: sources.length,
    pageCount: sources.reduce((total, source) => total + source.pageCount, 0),
    pagesProcessed: sources.reduce(
      (total, source) => total + source.pagesProcessed,
      0
    ),
    providerLatencyMs: sources.reduce(
      (total, source) => total + source.latencyMs,
      0
    ),
    // One uncosted source makes the whole total unknown rather than
    // understated, so the interface can say so instead of showing $0.0000.
    estimatedCostUsd: sources.some((source) => source.estimatedCostUsd === null)
      ? null
      : Math.round(
          sources.reduce(
            (total, source) => total + (source.estimatedCostUsd ?? 0),
            0
          ) * 1e6
        ) / 1e6,
    elapsedMs,
  }
}

async function persistPages(
  env: Env,
  runId: string,
  rows: { source: StoredSource; page: OcrPage }[]
): Promise<void> {
  if (rows.length === 0) return

  const now = new Date().toISOString()

  await env.DB.batch(
    rows.map(({ source, page }) =>
      env.DB.prepare(
        `INSERT INTO run_source_pages (
           id, run_id, source_id, page_number, markdown, width, height, dpi,
           regions, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, page_number) DO UPDATE SET
           markdown = excluded.markdown,
           regions = excluded.regions`
      ).bind(
        crypto.randomUUID(),
        runId,
        source.id,
        page.pageNumber,
        page.markdown,
        page.width,
        page.height,
        page.dpi,
        JSON.stringify(page.regions),
        now
      )
    )
  )
}

function formatSeconds(elapsedMs: number): string {
  const elapsed = Math.max(elapsedMs, 0)
  return elapsed < 1000 ? `${elapsed} ms` : `${(elapsed / 1000).toFixed(1)} s`
}
