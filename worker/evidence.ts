/**
 * Read-only evidence projections.
 *
 * Every holder of a run URL, owner or not, sees the same allowlisted evidence:
 * the sources a run was given, the text read from each page with its
 * provenance, the validated RFQ, the exact model messages and response behind
 * it, the customer the run resolved to and why, and sanitized provider
 * metadata. Nothing here can expose an owner capability, an API key, a request
 * header, or a raw provider error because only these fields are selected.
 *
 * Each projection lists the business result before the original model output,
 * which is the order the interface reads them in.
 */

import { z } from "zod"

import {
  ADAPTERS,
  DEFAULT_ADAPTER,
  SIMULATION_NOTICE,
  storedAdapterDescription,
  type AdapterDescription,
  type AdapterId,
  type AdapterPayload,
  type AdapterReceipt,
} from "./adapters"
import {
  BUILD_ESTIMATE_STEP_KEY,
  ESTIMATE_EVIDENCE_KIND,
  ESTIMATE_EVIDENCE_SCHEMA,
  loadQuote,
} from "./build-estimate"
import { DELIVER_STEP_KEY, loadDelivery } from "./deliver"
import {
  MATCH_PRODUCTS_STEP_KEY,
  MATCHES_EVIDENCE_KIND,
  MATCHES_EVIDENCE_SCHEMA,
} from "./match-products"
import {
  DOCUMENTS_EVIDENCE_KIND,
  DOCUMENTS_EVIDENCE_SCHEMA,
  READ_DOCUMENTS_STEP_KEY,
  type DocumentsEvidence,
} from "./read-documents"
import {
  CUSTOMER_EVIDENCE_KIND,
  CUSTOMER_EVIDENCE_SCHEMA,
  RESOLVE_CUSTOMER_STEP_KEY,
} from "./resolve-customer"
import {
  CANDIDATES_EVIDENCE_KIND,
  CANDIDATES_EVIDENCE_SCHEMA,
  RETRIEVE_CANDIDATES_STEP_KEY,
} from "./retrieve-candidates"
import { STORED_OCR_REGIONS_SCHEMA } from "./providers/ocr"
import type { CanonicalQuote } from "./quote"
import { RFQ_RECEIVED_STEP_KEY } from "./runs"
import { loadSources, MAX_EMAIL_BODY_CHARS } from "./sources"
import {
  STRUCTURE_EVIDENCE_KIND,
  STRUCTURE_EVIDENCE_SCHEMA,
  STRUCTURE_RFQ_STEP_KEY,
} from "./structure-rfq"

/* -------------------------------------------------------------------------- */
/* RFQ received                                                               */
/* -------------------------------------------------------------------------- */

export type ReceivedSourceProjection = {
  id: string
  kind: string
  label: string
  mediaType: string
  byteSize: number
  /** The email body exactly as it was received; `null` for binary sources. */
  text: string | null
  /** Worker-served original of a binary source; `null` for the email body. */
  previewUrl: string | null
}

/**
 * What the run was given, before anything read it: the email body verbatim and
 * every attachment as stored. This is the request itself, so it is available
 * from the moment the run exists, whether or not reading later succeeds.
 */
export type ReceivedEvidenceProjection = {
  stepKey: string
  sources: ReceivedSourceProjection[]
}

export async function loadReceivedEvidence(
  env: Env,
  runId: string,
  viewId: string
): Promise<ReceivedEvidenceProjection> {
  const sources = await loadSources(env, runId)

  return {
    stepKey: RFQ_RECEIVED_STEP_KEY,
    sources: await Promise.all(
      sources.map(async (source) => ({
        id: source.id,
        kind: source.kind,
        label: source.label,
        mediaType: source.mediaType,
        byteSize: source.byteSize,
        text:
          source.mediaType === "text/plain"
            ? await readStoredText(env, source.storageKey)
            : null,
        previewUrl:
          source.mediaType === "text/plain"
            ? null
            : `/api/runs/${encodeURIComponent(viewId)}/sources/${source.id}`,
      }))
    ),
  }
}

/** The stored email body, bounded by the same limit its upload was. */
async function readStoredText(env: Env, storageKey: string): Promise<string> {
  const object = await env.ARTIFACTS.get(storageKey)
  if (!object) return ""

  return (await object.text()).slice(0, MAX_EMAIL_BODY_CHARS)
}

/* -------------------------------------------------------------------------- */
/* Read documents                                                             */
/* -------------------------------------------------------------------------- */

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

export async function loadDocumentEvidence(
  env: Env,
  runId: string
): Promise<DocumentEvidenceProjection> {
  const [sources, pages, stored] = await Promise.all([
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
    readOwnedEvidence(
      env,
      runId,
      READ_DOCUMENTS_STEP_KEY,
      DOCUMENTS_EVIDENCE_KIND,
      DOCUMENTS_EVIDENCE_SCHEMA
    ),
  ])

  const documents = stored.outcome === "read" ? stored.value : null
  const unreadable = stored.outcome === "unreadable"

  const perSource = new Map<string, DocumentsEvidence["sources"][number]>(
    (documents?.sources ?? []).map((entry) => [entry.sourceId, entry])
  )

  return {
    stepKey: READ_DOCUMENTS_STEP_KEY,
    state: unreadable ? "error" : (documents?.state ?? "pending"),
    message: unreadable
      ? UNREADABLE_EVIDENCE_MESSAGE
      : (documents?.message ?? null),
    provider: documents?.provider ?? null,
    model: documents?.model ?? null,
    totals: documents?.totals ?? null,
    sources: sources.map((source) => {
      const detail = perSource.get(source.id)

      return {
        id: source.id,
        kind: source.kind,
        label: source.label,
        mediaType: source.mediaType,
        byteSize: source.byteSize,
        reader: detail?.reader ?? null,
        latencyMs: detail?.latencyMs ?? null,
        pagesProcessed: detail?.pagesProcessed ?? null,
        estimatedCostUsd: detail?.estimatedCostUsd ?? null,
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

/**
 * The page's regions, or none. A column this projection cannot read costs the
 * page its region overlay and nothing else, so the text still shows.
 */
function readRegions(raw: string): PageProjection["regions"] {
  const stored = STORED_OCR_REGIONS_SCHEMA.safeParse(raw)
  if (!stored.success) return []

  return stored.data.map((region) => ({
    id: region.id,
    box: [
      region.topLeftX,
      region.topLeftY,
      region.bottomRightX,
      region.bottomRightY,
    ],
  }))
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
  /** Exact system and user messages supplied to the model. */
  modelInput: { system: string; user: string } | null
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
  const stored = await readOwnedEvidence(
    env,
    runId,
    STRUCTURE_RFQ_STEP_KEY,
    STRUCTURE_EVIDENCE_KIND,
    STRUCTURE_EVIDENCE_SCHEMA
  )

  const structure = stored.outcome === "read" ? stored.value : null
  const unreadable = stored.outcome === "unreadable"

  return {
    stepKey: STRUCTURE_RFQ_STEP_KEY,
    state: unreadable ? "error" : (structure?.state ?? "pending"),
    message: unreadable
      ? UNREADABLE_EVIDENCE_MESSAGE
      : (structure?.message ?? null),
    validated: structure?.validated ?? null,
    confidence: structure?.confidence ?? null,
    repaired: structure?.repaired ?? false,
    issues: structure?.issues ?? [],
    modelInput: structure?.modelInput ?? null,
    originalOutput: structure?.originalOutput ?? null,
    provider: structure?.provider ?? null,
    model: structure?.model ?? null,
    usage: structure?.usage ?? null,
    metrics: structure?.metrics ?? null,
    estimatedCostUsd: structure?.estimatedCostUsd ?? null,
    reportedCostUsd: structure?.reportedCostUsd ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* Resolve customer                                                           */
/* -------------------------------------------------------------------------- */

export type CustomerEvidenceProjection = {
  stepKey: string
  /** `error` only ever means the stored row could not be read. */
  state: "pending" | "resolved" | "unresolved" | "error"
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
  const stored = await readOwnedEvidence(
    env,
    runId,
    RESOLVE_CUSTOMER_STEP_KEY,
    CUSTOMER_EVIDENCE_KIND,
    CUSTOMER_EVIDENCE_SCHEMA
  )

  const customer = stored.outcome === "read" ? stored.value : null
  const unreadable = stored.outcome === "unreadable"

  return {
    stepKey: RESOLVE_CUSTOMER_STEP_KEY,
    state: unreadable ? "error" : (customer?.state ?? "pending"),
    message: unreadable
      ? UNREADABLE_EVIDENCE_MESSAGE
      : (customer?.message ?? null),
    method: customer?.method ?? null,
    resolution: customer?.resolution ?? null,
    confidence: customer?.confidence ?? null,
    signals: customer?.signals ?? [],
    candidates: customer?.candidates ?? [],
    inputs: customer?.inputs ?? null,
    metrics: customer?.metrics ?? null,
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
  const stored = await readOwnedEvidence(
    env,
    runId,
    RETRIEVE_CANDIDATES_STEP_KEY,
    CANDIDATES_EVIDENCE_KIND,
    CANDIDATES_EVIDENCE_SCHEMA
  )

  const candidates = stored.outcome === "read" ? stored.value : null
  const unreadable = stored.outcome === "unreadable"

  return {
    stepKey: RETRIEVE_CANDIDATES_STEP_KEY,
    state: unreadable ? "error" : (candidates?.state ?? "pending"),
    message: unreadable
      ? UNREADABLE_EVIDENCE_MESSAGE
      : (candidates?.message ?? null),
    method: candidates?.method ?? null,
    shortlistSize: candidates?.shortlistSize ?? 0,
    customerScoped: candidates?.customerScoped ?? false,
    catalog: candidates?.catalog ?? null,
    lines: candidates?.lines ?? [],
    totals: candidates?.totals ?? null,
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
  /** Exact system and user messages supplied to the model, if one was used. */
  modelInput: { system: string; user: string } | null
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
  const stored = await readOwnedEvidence(
    env,
    runId,
    MATCH_PRODUCTS_STEP_KEY,
    MATCHES_EVIDENCE_KIND,
    MATCHES_EVIDENCE_SCHEMA
  )

  const matches = stored.outcome === "read" ? stored.value : null
  const unreadable = stored.outcome === "unreadable"

  return {
    stepKey: MATCH_PRODUCTS_STEP_KEY,
    state: unreadable ? "error" : (matches?.state ?? "pending"),
    message: unreadable
      ? UNREADABLE_EVIDENCE_MESSAGE
      : (matches?.message ?? null),
    provider: matches?.provider ?? null,
    model: matches?.model ?? null,
    heuristics: matches?.heuristics ?? null,
    lines: matches?.lines ?? [],
    totals: matches?.totals ?? null,
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
    readOwnedEvidence(
      env,
      runId,
      BUILD_ESTIMATE_STEP_KEY,
      ESTIMATE_EVIDENCE_KIND,
      ESTIMATE_EVIDENCE_SCHEMA
    ),
    loadQuote(env, runId),
  ])

  const estimate = stored.outcome === "read" ? stored.value : null
  const unreadable = stored.outcome === "unreadable"

  return {
    stepKey: BUILD_ESTIMATE_STEP_KEY,
    state: unreadable ? "error" : (estimate?.state ?? "pending"),
    message: unreadable
      ? UNREADABLE_EVIDENCE_MESSAGE
      : (estimate?.message ?? null),
    quote,
    rules: estimate?.rules ?? null,
    totals: estimate?.totals ?? null,
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
    /** `null` when the stored document no longer fits the adapter's contract. */
    payload: AdapterPayload | null
    receipt: AdapterReceipt | null
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

/**
 * What a projection says instead of showing evidence it could not read. It
 * names no field, no value, and no run: everything specific about the failure
 * goes to the log line, which is not served to anyone.
 */
const UNREADABLE_EVIDENCE_MESSAGE =
  "The stored evidence for this step could not be read."

/**
 * One evidence row, read with the schema its writing step owns.
 *
 * `absent` is the ordinary state of a step that has not written yet. A row that
 * no longer fits its schema is `unreadable` rather than a throw: whoever is
 * looking at the run asked to see it, not to run it, and a projection that says
 * "this step errored" is more use to them than a failed request.
 */
type StoredEvidence<Value> =
  | { outcome: "read"; value: Value }
  | { outcome: "absent" }
  | { outcome: "unreadable" }

/** The `payload` column as it is stored: one step's evidence, as JSON text. */
const PAYLOAD_TEXT_SCHEMA = z.string().transform((raw, ctx) => {
  try {
    const decoded: unknown = JSON.parse(raw)
    return decoded
  } catch {
    ctx.addIssue({ code: "custom", message: "The payload is not JSON text." })
    return z.NEVER
  }
})

async function readOwnedEvidence<Schema extends z.ZodType>(
  env: Env,
  runId: string,
  stepKey: string,
  kind: string,
  schema: Schema
): Promise<StoredEvidence<z.output<Schema>>> {
  const row = await env.DB.prepare(
    `SELECT payload FROM run_step_evidence
      WHERE run_id = ? AND step_key = ? AND kind = ?`
  )
    .bind(runId, stepKey, kind)
    .first<{ payload: string }>()

  if (!row) return { outcome: "absent" }

  const decoded = PAYLOAD_TEXT_SCHEMA.safeParse(row.payload)
  const result = decoded.success ? schema.safeParse(decoded.data) : null

  if (result?.success) return { outcome: "read", value: result.data }

  // The row itself is never logged. A payload can only have come from this
  // application, but it is still a stored value, and the three identifiers are
  // enough to find it.
  console.error(
    JSON.stringify({
      event: "evidence_payload_invalid",
      runId,
      step: stepKey,
      kind,
    })
  )

  return { outcome: "unreadable" }
}
