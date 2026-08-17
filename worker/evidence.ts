/**
 * Read-only evidence projections.
 *
 * Every holder of a run URL, owner or not, sees the same allowlisted evidence:
 * the sources a run was given, the text read from each page with its
 * provenance, the validated RFQ and the model text behind it, the customer the
 * run resolved to and why, and sanitized provider metadata. Nothing here can
 * expose an owner capability, an API key, a request header, a prompt, or a raw
 * provider error, because only these fields are selected and the stored payload
 * never contained them.
 *
 * Each projection lists the business result before the original model output,
 * which is the order the interface reads them in.
 */

import {
  ADAPTERS,
  DEFAULT_ADAPTER,
  SIMULATION_NOTICE,
  storedAdapterDescription,
  type AdapterDescription,
  type AdapterId,
} from "./adapters"
import { BUILD_ESTIMATE_STEP_KEY, loadQuote } from "./build-estimate"
import { DELIVER_STEP_KEY, loadDelivery } from "./deliver"
import { MATCH_PRODUCTS_STEP_KEY } from "./match-products"
import { READ_DOCUMENTS_STEP_KEY } from "./read-documents"
import { RESOLVE_CUSTOMER_STEP_KEY } from "./resolve-customer"
import { RETRIEVE_CANDIDATES_STEP_KEY } from "./retrieve-candidates"
import type { CanonicalQuote } from "./quote"
import { loadSources } from "./sources"
import { STRUCTURE_RFQ_STEP_KEY } from "./structure-rfq"

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
    /** `null` when a page price was not configured; never silently zero. */
    estimatedCostUsd: number | null
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
    estimatedCostUsd: readNumber(totals.estimatedCostUsd),
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

/* -------------------------------------------------------------------------- */
/* Structure RFQ                                                              */
/* -------------------------------------------------------------------------- */

export type ConfidenceProjection = {
  label: string
  score: number
  heuristic: string
} | null

export type ValidatedLineProjection = {
  position: number
  reference: string
  description: string
  quantity: number | null
  unit: string | null
  catalogSku: string | null
  sourceLabel: string
  sourcePage: number | null
  state: string
  reason: string | null
}

export type StructureEvidenceProjection = {
  stepKey: string
  state: "pending" | "complete" | "error"
  message: string | null
  /** The operational result comes first; the original response follows it. */
  validated: {
    customer: {
      companyName: string | null
      contactName: string | null
      contactEmail: string | null
      contactPhone: string | null
      deliveryLocation: string | null
    }
    source: {
      channel: string
      subject: string | null
      receivedAt: string | null
      references: string[]
    }
    deadline: { date: string | null; text: string | null }
    lineItems: ValidatedLineProjection[]
  } | null
  confidence: ConfidenceProjection
  repaired: boolean
  issues: string[]
  /** Model text as returned, truncated. It never contained a prompt or a key. */
  originalOutput: string | null
  provider: string | null
  model: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
  metrics: { latencyMs: number; elapsedMs: number } | null
  estimatedCostUsd: number | null
  reportedCostUsd: number | null
}

export async function loadStructureEvidence(
  env: Env,
  runId: string
): Promise<StructureEvidenceProjection> {
  const stored = await readStoredEvidence(
    env,
    runId,
    STRUCTURE_RFQ_STEP_KEY,
    "structure"
  )

  return {
    stepKey: STRUCTURE_RFQ_STEP_KEY,
    state: readState(stored?.state),
    message: readText(stored?.message),
    validated: readValidated(stored?.validated),
    confidence: readConfidence(stored?.confidence),
    repaired: stored?.repaired === true,
    issues: readStrings(stored?.issues),
    originalOutput: readText(stored?.originalOutput),
    provider: readText(stored?.provider),
    model: readText(stored?.model),
    usage: readUsage(stored?.usage),
    metrics: readMetrics(stored?.metrics),
    estimatedCostUsd: readNumber(stored?.estimatedCostUsd),
    reportedCostUsd: readNumber(stored?.reportedCostUsd),
  }
}

function readValidated(
  value: unknown
): StructureEvidenceProjection["validated"] {
  if (typeof value !== "object" || value === null) return null

  const validated = value as Record<string, unknown>
  const customer = asRecord(validated.customer)
  const source = asRecord(validated.source)
  const deadline = asRecord(validated.deadline)

  return {
    customer: {
      companyName: readText(customer.companyName),
      contactName: readText(customer.contactName),
      contactEmail: readText(customer.contactEmail),
      contactPhone: readText(customer.contactPhone),
      deliveryLocation: readText(customer.deliveryLocation),
    },
    source: {
      channel: readText(source.channel) ?? "email",
      subject: readText(source.subject),
      receivedAt: readText(source.receivedAt),
      references: readStrings(source.references),
    },
    deadline: {
      date: readText(deadline.date),
      text: readText(deadline.text),
    },
    lineItems: (Array.isArray(validated.lineItems)
      ? validated.lineItems
      : []
    ).map((entry, index) => {
      const line = asRecord(entry)

      return {
        position: readNumber(line.position) ?? index + 1,
        reference: readText(line.reference) ?? "",
        description: readText(line.description) ?? "",
        quantity: readNumber(line.quantity),
        unit: readText(line.unit),
        catalogSku: readText(line.catalogSku),
        sourceLabel: readText(line.sourceLabel) ?? "",
        sourcePage: readNumber(line.sourcePage),
        state: readText(line.state) ?? "accepted",
        reason: readText(line.reason),
      }
    }),
  }
}

/* -------------------------------------------------------------------------- */
/* Resolve customer                                                           */
/* -------------------------------------------------------------------------- */

export type CustomerEvidenceProjection = {
  stepKey: string
  state: "pending" | "resolved" | "unresolved"
  message: string | null
  method: string | null
  resolution: {
    customerId: string
    name: string
    tier: string
    contact: {
      id: string
      name: string
      role: string
      email: string
    } | null
    location: {
      id: string
      label: string
      city: string
      country: string
    } | null
  } | null
  confidence: ConfidenceProjection
  signals: { kind: string; detail: string; weight: number }[]
  candidates: {
    customerId: string
    name: string
    score: number
    signals: string[]
  }[]
  inputs: {
    contactEmail: string | null
    companyName: string | null
    deliveryLocation: string | null
    referenceCount: number
  } | null
  metrics: { elapsedMs: number } | null
}

export async function loadCustomerEvidence(
  env: Env,
  runId: string
): Promise<CustomerEvidenceProjection> {
  const stored = await readStoredEvidence(
    env,
    runId,
    RESOLVE_CUSTOMER_STEP_KEY,
    "customer"
  )
  const inputs = stored?.inputs ? asRecord(stored.inputs) : null

  return {
    stepKey: RESOLVE_CUSTOMER_STEP_KEY,
    state:
      stored?.state === "resolved" || stored?.state === "unresolved"
        ? stored.state
        : "pending",
    message: readText(stored?.message),
    method: readText(stored?.method),
    resolution: readResolution(stored?.resolution),
    confidence: readConfidence(stored?.confidence),
    signals: (Array.isArray(stored?.signals) ? stored.signals : []).map(
      (entry) => {
        const signal = asRecord(entry)

        return {
          kind: readText(signal.kind) ?? "",
          detail: readText(signal.detail) ?? "",
          weight: readNumber(signal.weight) ?? 0,
        }
      }
    ),
    candidates: (Array.isArray(stored?.candidates)
      ? stored.candidates
      : []
    ).map((entry) => {
      const candidate = asRecord(entry)

      return {
        customerId: readText(candidate.customerId) ?? "",
        name: readText(candidate.name) ?? "",
        score: readNumber(candidate.score) ?? 0,
        signals: readStrings(candidate.signals),
      }
    }),
    inputs: inputs
      ? {
          contactEmail: readText(inputs.contactEmail),
          companyName: readText(inputs.companyName),
          deliveryLocation: readText(inputs.deliveryLocation),
          referenceCount: readNumber(inputs.referenceCount) ?? 0,
        }
      : null,
    metrics: stored?.metrics
      ? { elapsedMs: readNumber(asRecord(stored.metrics).elapsedMs) ?? 0 }
      : null,
  }
}

function readResolution(
  value: unknown
): CustomerEvidenceProjection["resolution"] {
  if (typeof value !== "object" || value === null) return null

  const resolution = value as Record<string, unknown>
  const contact = resolution.contact ? asRecord(resolution.contact) : null
  const location = resolution.location ? asRecord(resolution.location) : null

  return {
    customerId: readText(resolution.customerId) ?? "",
    name: readText(resolution.name) ?? "",
    tier: readText(resolution.tier) ?? "",
    contact: contact
      ? {
          id: readText(contact.id) ?? "",
          name: readText(contact.name) ?? "",
          role: readText(contact.role) ?? "",
          email: readText(contact.email) ?? "",
        }
      : null,
    location: location
      ? {
          id: readText(location.id) ?? "",
          label: readText(location.label) ?? "",
          city: readText(location.city) ?? "",
          country: readText(location.country) ?? "",
        }
      : null,
  }
}

/* -------------------------------------------------------------------------- */
/* Retrieve candidates                                                        */
/* -------------------------------------------------------------------------- */

export type CandidateProjection = {
  rank: number
  sku: string
  name: string
  category: string
  manufacturer: string
  unit: string
  source: string
  score: number
  evidence: string
  nearDuplicateOf: string | null
}

export type CandidateLineProjection = {
  position: number
  reference: string
  description: string
  query: string
  state: string
  supersededSku: string | null
  note: string
  candidates: CandidateProjection[]
}

export type CandidateEvidenceProjection = {
  stepKey: string
  state: "pending" | "complete" | "error"
  message: string | null
  method: string | null
  shortlistSize: number
  customerScoped: boolean
  catalog: {
    activeProducts: number
    totalProducts: number
    archivedExcluded: number
  } | null
  lines: CandidateLineProjection[]
  totals: {
    lineCount: number
    exactCount: number
    retrievedCount: number
    candidateCount: number
    elapsedMs: number
  } | null
}

export async function loadCandidateEvidence(
  env: Env,
  runId: string
): Promise<CandidateEvidenceProjection> {
  const stored = await readStoredEvidence(
    env,
    runId,
    RETRIEVE_CANDIDATES_STEP_KEY,
    "candidates"
  )

  const catalog = stored?.catalog ? asRecord(stored.catalog) : null
  const totals = stored?.totals ? asRecord(stored.totals) : null

  return {
    stepKey: RETRIEVE_CANDIDATES_STEP_KEY,
    state: readState(stored?.state),
    message: readText(stored?.message),
    method: readText(stored?.method),
    shortlistSize: readNumber(stored?.shortlistSize) ?? 0,
    customerScoped: stored?.customerScoped === true,
    catalog: catalog
      ? {
          activeProducts: readNumber(catalog.activeProducts) ?? 0,
          totalProducts: readNumber(catalog.totalProducts) ?? 0,
          archivedExcluded: readNumber(catalog.archivedExcluded) ?? 0,
        }
      : null,
    lines: (Array.isArray(stored?.lines) ? stored.lines : []).map((entry) => {
      const line = asRecord(entry)

      return {
        position: readNumber(line.position) ?? 0,
        reference: readText(line.reference) ?? "",
        description: readText(line.description) ?? "",
        query: readText(line.query) ?? "",
        state: readText(line.state) ?? "retrieved",
        supersededSku: readText(line.supersededSku),
        note: readText(line.note) ?? "",
        candidates: (Array.isArray(line.candidates) ? line.candidates : []).map(
          (value, index) => {
            const candidate = asRecord(value)

            return {
              rank: readNumber(candidate.rank) ?? index + 1,
              sku: readText(candidate.sku) ?? "",
              name: readText(candidate.name) ?? "",
              category: readText(candidate.category) ?? "",
              manufacturer: readText(candidate.manufacturer) ?? "",
              unit: readText(candidate.unit) ?? "",
              source: readText(candidate.source) ?? "",
              score: readNumber(candidate.score) ?? 0,
              evidence: readText(candidate.evidence) ?? "",
              nearDuplicateOf: readText(candidate.nearDuplicateOf),
            }
          }
        ),
      }
    }),
    totals: totals
      ? {
          lineCount: readNumber(totals.lineCount) ?? 0,
          exactCount: readNumber(totals.exactCount) ?? 0,
          retrievedCount: readNumber(totals.retrievedCount) ?? 0,
          candidateCount: readNumber(totals.candidateCount) ?? 0,
          elapsedMs: readNumber(totals.elapsedMs) ?? 0,
        }
      : null,
  }
}

/* -------------------------------------------------------------------------- */
/* Match products                                                             */
/* -------------------------------------------------------------------------- */

export type MatchAlternativeProjection = {
  sku: string
  name: string
  score: number
  reason: string
  nearDuplicateOf: string | null
}

export type MatchLineProjection = {
  position: number
  reference: string
  description: string
  /** The business result first: what was decided, and on what evidence. */
  state: string
  sku: string | null
  productName: string | null
  method: string
  decisionEvidence: string
  confidence: ConfidenceProjection
  winnerScore: number
  winnerGap: number
  alternatives: MatchAlternativeProjection[]
  rejected: { sku: string; reason: string }[]
  candidateCount: number
  shortlistSize: number
  repaired: boolean
  issues: string[]
  /** Model text as returned, truncated. It never contained a prompt or a key. */
  originalOutput: string | null
  latencyMs: number | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
}

export type MatchEvidenceProjection = {
  stepKey: string
  state: "pending" | "complete" | "error"
  message: string | null
  provider: string | null
  model: string | null
  heuristics: {
    winnerStrength: number
    winnerGap: number
    note: string
  } | null
  lines: MatchLineProjection[]
  totals: {
    lineCount: number
    acceptedCount: number
    reviewCount: number
    deterministicCount: number
    rerankedCount: number
    modelCalls: number
    providerLatencyMs: number
    usage: {
      inputTokens: number
      outputTokens: number
      totalTokens: number
    } | null
    estimatedCostUsd: number | null
    elapsedMs: number
  } | null
}

export async function loadMatchEvidence(
  env: Env,
  runId: string
): Promise<MatchEvidenceProjection> {
  const stored = await readStoredEvidence(
    env,
    runId,
    MATCH_PRODUCTS_STEP_KEY,
    "matches"
  )

  const heuristics = stored?.heuristics ? asRecord(stored.heuristics) : null
  const totals = stored?.totals ? asRecord(stored.totals) : null

  return {
    stepKey: MATCH_PRODUCTS_STEP_KEY,
    state: readState(stored?.state),
    message: readText(stored?.message),
    provider: readText(stored?.provider),
    model: readText(stored?.model),
    heuristics: heuristics
      ? {
          winnerStrength: readNumber(heuristics.winnerStrength) ?? 0,
          winnerGap: readNumber(heuristics.winnerGap) ?? 0,
          note: readText(heuristics.note) ?? "",
        }
      : null,
    lines: (Array.isArray(stored?.lines) ? stored.lines : []).map((entry) => {
      const line = asRecord(entry)

      return {
        position: readNumber(line.position) ?? 0,
        reference: readText(line.reference) ?? "",
        description: readText(line.description) ?? "",
        state: readText(line.state) ?? "review_required",
        sku: readText(line.sku),
        productName: readText(line.productName),
        method: readText(line.method) ?? "none",
        decisionEvidence: readText(line.decisionEvidence) ?? "",
        confidence: readConfidence(line.confidence),
        winnerScore: readNumber(line.winnerScore) ?? 0,
        winnerGap: readNumber(line.winnerGap) ?? 0,
        alternatives: (Array.isArray(line.alternatives)
          ? line.alternatives
          : []
        ).map((value) => {
          const alternative = asRecord(value)

          return {
            sku: readText(alternative.sku) ?? "",
            name: readText(alternative.name) ?? "",
            score: readNumber(alternative.score) ?? 0,
            reason: readText(alternative.reason) ?? "",
            nearDuplicateOf: readText(alternative.nearDuplicateOf),
          }
        }),
        rejected: (Array.isArray(line.rejected) ? line.rejected : []).map(
          (value) => {
            const rejected = asRecord(value)

            return {
              sku: readText(rejected.sku) ?? "",
              reason: readText(rejected.reason) ?? "",
            }
          }
        ),
        candidateCount: readNumber(line.candidateCount) ?? 0,
        shortlistSize: readNumber(line.shortlistSize) ?? 0,
        repaired: line.repaired === true,
        issues: readStrings(line.issues),
        originalOutput: readText(line.originalOutput),
        latencyMs: readNumber(line.latencyMs),
        usage: readUsage(line.usage),
      }
    }),
    totals: totals
      ? {
          lineCount: readNumber(totals.lineCount) ?? 0,
          acceptedCount: readNumber(totals.acceptedCount) ?? 0,
          reviewCount: readNumber(totals.reviewCount) ?? 0,
          deterministicCount: readNumber(totals.deterministicCount) ?? 0,
          rerankedCount: readNumber(totals.rerankedCount) ?? 0,
          modelCalls: readNumber(totals.modelCalls) ?? 0,
          providerLatencyMs: readNumber(totals.providerLatencyMs) ?? 0,
          usage: readUsage(totals.usage),
          estimatedCostUsd: readNumber(totals.estimatedCostUsd),
          elapsedMs: readNumber(totals.elapsedMs) ?? 0,
        }
      : null,
  }
}

/* -------------------------------------------------------------------------- */
/* Build estimate                                                             */
/* -------------------------------------------------------------------------- */

export type EstimateEvidenceProjection = {
  stepKey: string
  state: "pending" | "complete" | "error"
  message: string | null
  /**
   * The canonical quote exactly as it was built and stored. It was assembled
   * from an allowlist, so it holds business facts only — never a storage key,
   * a capability, a prompt, or a provider response.
   */
  quote: CanonicalQuote | null
  rules: {
    precedence: string[]
    applied: { rule: string; lineCount: number }[]
    vatRateBp: number
    rounding: string
    note: string
  } | null
  totals: {
    lineCount: number
    subtotalCents: number
    vatRateBp: number
    vatCents: number
    totalCents: number
    elapsedMs: number
  } | null
}

export async function loadEstimateEvidence(
  env: Env,
  runId: string
): Promise<EstimateEvidenceProjection> {
  const [stored, quote] = await Promise.all([
    readStoredEvidence(env, runId, BUILD_ESTIMATE_STEP_KEY, "estimate"),
    loadQuote(env, runId),
  ])

  const rules = stored?.rules ? asRecord(stored.rules) : null
  const totals = stored?.totals ? asRecord(stored.totals) : null

  return {
    stepKey: BUILD_ESTIMATE_STEP_KEY,
    state: readState(stored?.state),
    message: readText(stored?.message),
    quote,
    rules: rules
      ? {
          precedence: readStrings(rules.precedence),
          applied: (Array.isArray(rules.applied) ? rules.applied : []).map(
            (entry) => {
              const applied = asRecord(entry)

              return {
                rule: readText(applied.rule) ?? "",
                lineCount: readNumber(applied.lineCount) ?? 0,
              }
            }
          ),
          vatRateBp: readNumber(rules.vatRateBp) ?? 0,
          rounding: readText(rules.rounding) ?? "",
          note: readText(rules.note) ?? "",
        }
      : null,
    totals: totals
      ? {
          lineCount: readNumber(totals.lineCount) ?? 0,
          subtotalCents: readNumber(totals.subtotalCents) ?? 0,
          vatRateBp: readNumber(totals.vatRateBp) ?? 0,
          vatCents: readNumber(totals.vatCents) ?? 0,
          totalCents: readNumber(totals.totalCents) ?? 0,
          elapsedMs: readNumber(totals.elapsedMs) ?? 0,
        }
      : null,
  }
}

/* -------------------------------------------------------------------------- */
/* Deliver                                                                    */
/* -------------------------------------------------------------------------- */

export type DeliveryEvidenceProjection = {
  stepKey: string
  /** The single simulated destination, visible before use. */
  adapters: AdapterDescription[]
  defaultAdapter: AdapterId
  /** Whether pricing has produced a quote for an adapter to transform. */
  quoteAvailable: boolean
  quoteNumber: string | null
  delivery: {
    adapter: string
    adapterName: string
    externalEstimateId: string
    deliveredAt: string
    simulated: true
    notice: string
    payload: unknown
    receipt: unknown
  } | null
}

export async function loadDeliveryEvidence(
  env: Env,
  runId: string
): Promise<DeliveryEvidenceProjection> {
  const [quote, delivery] = await Promise.all([
    loadQuote(env, runId),
    loadDelivery(env, runId),
  ])

  return {
    stepKey: DELIVER_STEP_KEY,
    adapters: [ADAPTERS[DEFAULT_ADAPTER]],
    defaultAdapter: DEFAULT_ADAPTER,
    quoteAvailable: quote !== null,
    quoteNumber: quote?.quoteNumber ?? null,
    delivery: delivery
      ? {
          adapter: delivery.adapter,
          adapterName: storedAdapterDescription(delivery.adapter).name,
          externalEstimateId: delivery.externalEstimateId,
          deliveredAt: delivery.deliveredAt,
          simulated: true,
          notice: SIMULATION_NOTICE,
          payload: delivery.payload,
          receipt: delivery.receipt,
        }
      : null,
  }
}

/* -------------------------------------------------------------------------- */
/* Shared readers                                                             */
/* -------------------------------------------------------------------------- */

async function readStoredEvidence(
  env: Env,
  runId: string,
  stepKey: string,
  kind: string
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    `SELECT payload FROM run_step_evidence
      WHERE run_id = ? AND step_key = ? AND kind = ?`
  )
    .bind(runId, stepKey, kind)
    .first<{ payload: string }>()

  if (!row) return null

  try {
    const parsed: unknown = JSON.parse(row.payload)
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readConfidence(value: unknown): ConfidenceProjection {
  if (typeof value !== "object" || value === null) return null

  const confidence = value as Record<string, unknown>

  return {
    label: readText(confidence.label) ?? "Review",
    score: readNumber(confidence.score) ?? 0,
    heuristic: readText(confidence.heuristic) ?? "",
  }
}

function readUsage(value: unknown): StructureEvidenceProjection["usage"] {
  if (typeof value !== "object" || value === null) return null

  const usage = value as Record<string, unknown>

  return {
    inputTokens: readNumber(usage.inputTokens) ?? 0,
    outputTokens: readNumber(usage.outputTokens) ?? 0,
    totalTokens: readNumber(usage.totalTokens) ?? 0,
  }
}

function readMetrics(value: unknown): StructureEvidenceProjection["metrics"] {
  if (typeof value !== "object" || value === null) return null

  const metrics = value as Record<string, unknown>

  return {
    latencyMs: readNumber(metrics.latencyMs) ?? 0,
    elapsedMs: readNumber(metrics.elapsedMs) ?? 0,
  }
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

function readText(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}
