/**
 * Read-only evidence projections.
 *
 * Every holder of a run URL, owner or not, sees the same allowlisted evidence:
 * the sources a run was given, the text read from each page with its
 * provenance, and sanitized provider metadata. Nothing here can expose an owner
 * capability, an API key, a request header, or a raw provider error, because
 * only these fields are selected and the stored payload never contained them.
 */

import { READ_DOCUMENTS_STEP_KEY } from "./read-documents"
import { loadSources } from "./sources"

export type PageProjection = {
  pageNumber: number
  markdown: string
  width: number | null
  height: number | null
  dpi: number | null
  regions: { id: string; box: [number, number, number, number] }[]
}

export type SourceProjection = {
  id: string
  kind: string
  label: string
  mediaType: string
  byteSize: number
  /** Worker-served preview of the original; absent for text sources. */
  previewUrl: string | null
  reader: string | null
  latencyMs: number | null
  pagesProcessed: number | null
  estimatedCostUsd: number | null
  sanitizedResponse: unknown
  pages: PageProjection[]
}

export type DocumentEvidenceProjection = {
  stepKey: string
  state: "pending" | "complete" | "error"
  message: string | null
  provider: string | null
  model: string | null
  totals: {
    sourceCount: number
    pageCount: number
    pagesProcessed: number
    providerLatencyMs: number
    estimatedCostUsd: number
    elapsedMs: number
  } | null
  sources: SourceProjection[]
}

type StoredEvidence = {
  provider?: unknown
  model?: unknown
  state?: unknown
  message?: unknown
  totals?: unknown
  sources?: unknown
}

type StoredSourceEvidence = {
  sourceId?: unknown
  reader?: unknown
  latencyMs?: unknown
  pagesProcessed?: unknown
  estimatedCostUsd?: unknown
  sanitizedResponse?: unknown
}

export async function loadDocumentEvidence(
  env: Env,
  runId: string,
  viewId: string
): Promise<DocumentEvidenceProjection> {
  const [sources, pages, evidenceRow] = await Promise.all([
    loadSources(env, runId),
    env.DB.prepare(
      `SELECT source_id, page_number, markdown, width, height, dpi, regions
         FROM run_source_pages WHERE run_id = ?
        ORDER BY source_id ASC, page_number ASC`
    )
      .bind(runId)
      .all<{
        source_id: string
        page_number: number
        markdown: string
        width: number | null
        height: number | null
        dpi: number | null
        regions: string
      }>(),
    env.DB.prepare(
      `SELECT payload FROM run_step_evidence
        WHERE run_id = ? AND step_key = ? AND kind = 'documents'`
    )
      .bind(runId, READ_DOCUMENTS_STEP_KEY)
      .first<{ payload: string }>(),
  ])

  const stored = parseEvidence(evidenceRow?.payload)
  const perSource = new Map<string, StoredSourceEvidence>()

  if (Array.isArray(stored?.sources)) {
    for (const entry of stored.sources as StoredSourceEvidence[]) {
      if (typeof entry?.sourceId === "string")
        perSource.set(entry.sourceId, entry)
    }
  }

  return {
    stepKey: READ_DOCUMENTS_STEP_KEY,
    state: readState(stored?.state),
    message: typeof stored?.message === "string" ? stored.message : null,
    provider: typeof stored?.provider === "string" ? stored.provider : null,
    model: typeof stored?.model === "string" ? stored.model : null,
    totals: readTotals(stored?.totals),
    sources: sources.map((source) => {
      const detail = perSource.get(source.id)

      return {
        id: source.id,
        kind: source.kind,
        label: source.label,
        mediaType: source.mediaType,
        byteSize: source.byteSize,
        previewUrl:
          source.mediaType === "text/plain"
            ? null
            : `/api/runs/${encodeURIComponent(viewId)}/sources/${source.id}`,
        reader: typeof detail?.reader === "string" ? detail.reader : null,
        latencyMs: readNumber(detail?.latencyMs),
        pagesProcessed: readNumber(detail?.pagesProcessed),
        estimatedCostUsd: readNumber(detail?.estimatedCostUsd),
        sanitizedResponse: detail?.sanitizedResponse ?? null,
        pages: pages.results
          .filter((page) => page.source_id === source.id)
          .map((page) => ({
            pageNumber: page.page_number,
            markdown: page.markdown,
            width: page.width,
            height: page.height,
            dpi: page.dpi,
            regions: readRegions(page.regions),
          })),
      }
    }),
  }
}

function parseEvidence(payload: string | undefined): StoredEvidence | null {
  if (!payload) return null

  try {
    return JSON.parse(payload) as StoredEvidence
  } catch {
    return null
  }
}

function readState(value: unknown): DocumentEvidenceProjection["state"] {
  return value === "complete" || value === "error" ? value : "pending"
}

function readTotals(value: unknown): DocumentEvidenceProjection["totals"] {
  if (typeof value !== "object" || value === null) return null

  const totals = value as Record<string, unknown>

  return {
    sourceCount: readNumber(totals.sourceCount) ?? 0,
    pageCount: readNumber(totals.pageCount) ?? 0,
    pagesProcessed: readNumber(totals.pagesProcessed) ?? 0,
    providerLatencyMs: readNumber(totals.providerLatencyMs) ?? 0,
    estimatedCostUsd: readNumber(totals.estimatedCostUsd) ?? 0,
    elapsedMs: readNumber(totals.elapsedMs) ?? 0,
  }
}

function readRegions(raw: string): PageProjection["regions"] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.map((entry, index) => {
      const region = (entry ?? {}) as Record<string, unknown>

      return {
        id: typeof region.id === "string" ? region.id : `region-${index + 1}`,
        box: [
          readNumber(region.topLeftX) ?? 0,
          readNumber(region.topLeftY) ?? 0,
          readNumber(region.bottomRightX) ?? 0,
          readNumber(region.bottomRightY) ?? 0,
        ] as [number, number, number, number],
      }
    })
  } catch {
    return []
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
