import { readOwnerCapability, workspaceId } from "@/lib/run-store"

export type RunStepStatus =
  "waiting" | "active" | "complete" | "review_required" | "error"

export type RunStep = {
  key: string
  title: string
  position: number
  status: RunStepStatus
  summary: string
  startedAt: string | null
  completedAt: string | null
}

export type Run = {
  viewId: string
  status: string
  workflowState: string
  source: { kind: string; scenarioId: string | null }
  createdAt: string
  updatedAt: string
  steps: RunStep[]
}

export type Viewer = {
  isOwner: boolean
  access: "owner" | "shared"
  canMutate: boolean
}

export type RunView = { run: Run; viewer: Viewer }

export type RequestedItem = {
  position: number
  reference: string
  description: string
  quantity: number
  unit: string
  note: string
}

export type ScenarioAttachment = {
  kind: "pdf" | "image"
  filename: string
  url: string
  title: string
  caption: string
}

/** The curated source material the landing page shows before processing. */
export type Scenario = {
  id: string
  name: string
  featured: boolean
  sources: string
  difficulty: {
    level: "Low" | "Medium" | "High"
    summary: string
    expectedReview: string
  }
  email: {
    from: { name: string; email: string; company: string }
    to: string
    subject: string
    receivedAt: string
    forwarded: { from: string; date: string; subject: string } | null
    body: string[]
    signature: string[]
  }
  inlineImage: ScenarioAttachment
  pdfAttachment: ScenarioAttachment
  requestedItems: RequestedItem[]
}

export type SourcePage = {
  pageNumber: number
  markdown: string
  width: number | null
  height: number | null
  dpi: number | null
  regions: { id: string; box: [number, number, number, number] }[]
}

export type EvidenceSource = {
  id: string
  kind: "email_body" | "inline_image" | "attachment"
  label: string
  mediaType: string
  byteSize: number
  previewUrl: string | null
  reader: string | null
  latencyMs: number | null
  pagesProcessed: number | null
  estimatedCostUsd: number | null
  sanitizedResponse: unknown
  pages: SourcePage[]
}

export type DocumentEvidence = {
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
  sources: EvidenceSource[]
}

/** High, Medium, or Review beside a number the UI always calls a heuristic. */
export type Confidence = {
  label: string
  score: number
  heuristic: string
} | null

export type ValidatedLine = {
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

export type StructureEvidence = {
  stepKey: string
  state: "pending" | "complete" | "error"
  message: string | null
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
    lineItems: ValidatedLine[]
  } | null
  confidence: Confidence
  repaired: boolean
  issues: string[]
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

export type CustomerEvidence = {
  stepKey: string
  state: "pending" | "resolved" | "unresolved"
  message: string | null
  method: string | null
  resolution: {
    customerId: string
    name: string
    tier: string
    contact: { id: string; name: string; role: string; email: string } | null
    location: {
      id: string
      label: string
      city: string
      country: string
    } | null
  } | null
  confidence: Confidence
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

export type RetrievedCandidate = {
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

export type CandidateLine = {
  position: number
  reference: string
  description: string
  query: string
  state: string
  supersededSku: string | null
  note: string
  candidates: RetrievedCandidate[]
}

export type CandidateEvidence = {
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
  lines: CandidateLine[]
  totals: {
    lineCount: number
    exactCount: number
    retrievedCount: number
    candidateCount: number
    elapsedMs: number
  } | null
}

export type MatchAlternative = {
  sku: string
  name: string
  score: number
  reason: string
  nearDuplicateOf: string | null
}

export type MatchLine = {
  position: number
  reference: string
  description: string
  state: string
  sku: string | null
  productName: string | null
  method: string
  decisionEvidence: string
  confidence: Confidence
  winnerScore: number
  winnerGap: number
  alternatives: MatchAlternative[]
  rejected: { sku: string; reason: string }[]
  candidateCount: number
  shortlistSize: number
  repaired: boolean
  issues: string[]
  originalOutput: string | null
  latencyMs: number | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
}

export type MatchEvidence = {
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
  lines: MatchLine[]
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

export type ReviewAlternative = {
  /** A catalogue article number or a customer identifier, never free text. */
  value: string
  label: string
  detail: string
  score: number
}

export type ReviewItem = {
  id: string
  /** `customer`, `product`, `quantity`, or `field`. */
  kind: string
  position: number
  sourcePhrase: string
  detail: string
  proposal: {
    label: string
    sku: string | null
    quantity: number | null
    customerId: string | null
  }
  confidence: { label: string; score: number; heuristic: string }
  reasons: string[]
  alternatives: ReviewAlternative[]
  state: string
  decision: string | null
  resolved: {
    sku: string | null
    quantity: number | null
    customerId: string | null
    at: string | null
  }
}

export type Review = {
  stepKey: string
  state: "not_required" | "pending" | "approved" | "rejected" | "expired"
  openedAt: string | null
  expiresAt: string | null
  decidedAt: string | null
  summary: string | null
  itemCount: number
  resolvedCount: number
  canApprove: boolean
  note: string
  items: ReviewItem[]
}

export type ReviewDecisionInput = {
  itemId: string
  action: "accept" | "alternative" | "catalog" | "quantity" | "customer"
  sku?: string
  quantity?: number
  customerId?: string
}

export type PricingRule =
  "historical_override" | "customer_tier" | "quantity_break" | "catalog_base"

export type QuoteLine = {
  position: number
  requested: {
    reference: string
    description: string
    sourceLabel: string
    sourcePage: number | null
  }
  sku: string
  name: string
  unit: string
  quantity: number
  pricing: {
    rule: PricingRule
    ruleLabel: string
    basePriceCents: number
    unitPriceCents: number
    discountBp: number | null
    explanation: string
  }
  subtotalCents: number
  match: { method: string; confidenceLabel: string }
}

/** The provider-neutral quote. Adapters transform this and nothing else. */
export type CanonicalQuote = {
  schema: string
  quoteNumber: string
  issuedAt: string
  currency: string
  priceBasis: string
  customer: {
    customerId: string
    name: string
    tier: string
    tierDiscountBp: number
    contact: { name: string; role: string; email: string } | null
    location: {
      label: string
      street: string
      postalCode: string
      city: string
      country: string
    } | null
  }
  source: {
    channel: string
    subject: string | null
    receivedAt: string | null
    references: string[]
    documents: {
      kind: string
      label: string
      mediaType: string
      pageCount: number
    }[]
  }
  lines: QuoteLine[]
  totals: {
    lineCount: number
    subtotalCents: number
    vatRateBp: number
    vatCents: number
    totalCents: number
  }
  metadata: {
    generator: string
    schemaVersion: string
    pricingPrecedence: PricingRule[]
    rounding: string
    note: string
  }
}

export type EstimateEvidence = {
  stepKey: string
  state: "pending" | "complete" | "error"
  message: string | null
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

export type AdapterId = "generic-erp-webhook"

export type DeliveryAdapter = {
  id: AdapterId
  name: string
  contract: string
  payloadFormat: string
  simulated: boolean
  notice: string
}

export type DeliveryEvidence = {
  stepKey: string
  adapters: DeliveryAdapter[]
  defaultAdapter: AdapterId
  quoteAvailable: boolean
  quoteNumber: string | null
  delivery: {
    adapter: string
    adapterName: string
    externalEstimateId: string
    deliveredAt: string
    simulated: boolean
    notice: string
    payload: unknown
    receipt: unknown
  } | null
}

/** Mirrors the Worker's upload policy so a rejected file never leaves the browser. */
export const UPLOAD_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 6,
  accept: ["application/pdf", "image/jpeg", "image/png"],
  acceptAttribute: ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png",
} as const

/**
 * Mirrors the Worker's processing limit so the landing copy states the number
 * that is actually enforced.
 */
export const PROCESSING_LIMIT_PER_HOUR = 5

/**
 * Being over the hourly processing limit is not a failure of the visitor's
 * request; the interface says so in its own voice rather than as an error.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number

  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.name = "RateLimitedError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

async function readRateLimit(response: Response): Promise<RateLimitedError> {
  try {
    const body = (await response.json()) as {
      error?: string
      retryAfterSeconds?: number
    }

    return new RateLimitedError(
      body.error ?? "This demo is at its hourly run limit",
      body.retryAfterSeconds ?? 3600
    )
  } catch {
    return new RateLimitedError("This demo is at its hourly run limit", 3600)
  }
}

export class RunNotFoundError extends Error {
  constructor() {
    super("This run is unavailable or has expired")
    this.name = "RunNotFoundError"
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? "The request failed"
  } catch {
    return "The request failed"
  }
}

/** The technical context behind System details. Public and read-only. */
export type SystemDetails = {
  architecture: {
    summary: string
    pieces: { name: string; detail: string }[]
    steps: string[]
  }
  providers: {
    role: string
    provider: string
    model: string | null
    live: boolean
    detail: string
  }[]
  catalog: {
    activeProducts: number
    archivedProducts: number
    customers: number
    contacts: number
    locations: number
    historicalOrders: number
    aliases: number
    note: string
  }
  retrieval: { steps: string[]; shortlistSize: number; note: string }
  retention: { state: "planned" | "enforced"; summary: string; rows: string[] }
  rateLimit: { state: "planned" | "enforced"; summary: string }
  adapterContract: {
    summary: string
    defaultAdapter: string
    adapters: {
      id: string
      name: string
      contract: string
      payloadFormat: string
      simulated: boolean
    }[]
  }
  evaluation: { state: "planned" | "measured"; summary: string; rows: string[] }
}

export async function fetchSystemDetails(): Promise<SystemDetails> {
  const response = await fetch("/api/system")

  if (!response.ok) throw new Error(await readError(response))

  const body = (await response.json()) as { system: SystemDetails }
  return body.system
}

export const CATALOGUE_SECTIONS = [
  "products",
  "customers",
  "orders",
  "aliases",
] as const

export type CatalogueSection = (typeof CATALOGUE_SECTIONS)[number]

export function isCatalogueSection(value: string): value is CatalogueSection {
  return CATALOGUE_SECTIONS.includes(value as CatalogueSection)
}

export type CatalogueProduct = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  basePriceCents: number
  status: string
  replacementSku: string | null
  nearDuplicateOf: string | null
}

export type CatalogueCustomer = {
  id: string
  name: string
  domain: string
  tier: string
  tierDiscountBp: number
  contactCount: number
  contactNames: string[]
  locationCount: number
  cities: string[]
}

export type CatalogueOrder = {
  id: string
  orderedAt: string
  customerId: string
  customerName: string
  contactName: string
  city: string
  lineCount: number
  totalQuantity: number
  totalCents: number
  skus: string[]
}

export type CatalogueAlias = {
  alias: string
  kind: string
  sku: string
  productName: string
  customerId: string | null
  customerName: string | null
}

export type CatalogueProjection =
  | { section: "products"; rows: CatalogueProduct[] }
  | { section: "customers"; rows: CatalogueCustomer[] }
  | { section: "orders"; rows: CatalogueOrder[] }
  | { section: "aliases"; rows: CatalogueAlias[] }

/** The complete bounded synthetic catalogue projection for one table. */
export async function fetchCatalogue(
  section: CatalogueSection
): Promise<CatalogueProjection> {
  const response = await fetch(`/api/catalogue/${encodeURIComponent(section)}`)

  if (!response.ok) throw new Error(await readError(response))

  return ((await response.json()) as { catalogue: CatalogueProjection })
    .catalogue
}

export async function fetchScenarios(): Promise<Scenario[]> {
  const response = await fetch("/api/scenarios")

  if (!response.ok) throw new Error(await readError(response))

  const body = (await response.json()) as { scenarios: Scenario[] }
  return body.scenarios
}

type CreatedRun = { run: Run; viewer: Viewer; ownerCapability: string }

/** The workspace header is what later runs learn in; it is never a credential. */
function workspaceHeaders(): Record<string, string> {
  const workspace = workspaceId()
  return workspace ? { "x-workspace-id": workspace } : {}
}

export async function createRun(scenarioId: string): Promise<CreatedRun> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...workspaceHeaders() },
    body: JSON.stringify({ scenarioId }),
  })

  if (response.status === 429) throw await readRateLimit(response)
  if (!response.ok) throw new Error(await readError(response))

  return (await response.json()) as CreatedRun
}

/** Custom submissions post the email text and the original files as multipart. */
export async function createCustomRun(input: {
  emailBody: string
  files: File[]
}): Promise<CreatedRun> {
  const form = new FormData()
  form.set("emailBody", input.emailBody)
  for (const file of input.files) form.append("files", file)

  const response = await fetch("/api/runs", {
    method: "POST",
    headers: workspaceHeaders(),
    body: form,
  })

  if (response.status === 429) throw await readRateLimit(response)
  if (!response.ok) throw new Error(await readError(response))

  return (await response.json()) as CreatedRun
}

async function fetchEvidence<T>(viewId: string, segment: string): Promise<T> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/${segment}`
  )

  if (response.status === 404) throw new RunNotFoundError()
  if (!response.ok) throw new Error(await readError(response))

  const body = (await response.json()) as { evidence: T }
  return body.evidence
}

export function fetchDocumentEvidence(
  viewId: string
): Promise<DocumentEvidence> {
  return fetchEvidence<DocumentEvidence>(viewId, "documents")
}

export function fetchStructureEvidence(
  viewId: string
): Promise<StructureEvidence> {
  return fetchEvidence<StructureEvidence>(viewId, "structure")
}

export function fetchCustomerEvidence(
  viewId: string
): Promise<CustomerEvidence> {
  return fetchEvidence<CustomerEvidence>(viewId, "customer")
}

export function fetchCandidateEvidence(
  viewId: string
): Promise<CandidateEvidence> {
  return fetchEvidence<CandidateEvidence>(viewId, "candidates")
}

export function fetchMatchEvidence(viewId: string): Promise<MatchEvidence> {
  return fetchEvidence<MatchEvidence>(viewId, "matches")
}

export function fetchEstimateEvidence(
  viewId: string
): Promise<EstimateEvidence> {
  return fetchEvidence<EstimateEvidence>(viewId, "estimate")
}

export function fetchDeliveryEvidence(
  viewId: string
): Promise<DeliveryEvidence> {
  return fetchEvidence<DeliveryEvidence>(viewId, "delivery")
}

/** The review as evidence. Any holder of the run URL may read it. */
export async function fetchReview(viewId: string): Promise<Review> {
  const response = await fetch(`/api/runs/${encodeURIComponent(viewId)}/review`)

  if (response.status === 404) throw new RunNotFoundError()
  if (!response.ok) throw new Error(await readError(response))

  return ((await response.json()) as { review: Review }).review
}

function ownerHeaders(viewId: string): Record<string, string> {
  const capability = readOwnerCapability(viewId)
  if (!capability) throw new Error("This browser does not own this run")

  return { authorization: `Bearer ${capability}` }
}

/** Owner-only: records corrections. It releases nothing on its own. */
export async function submitReviewDecisions(
  viewId: string,
  decisions: ReviewDecisionInput[]
): Promise<Review> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review/decisions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders(viewId) },
      body: JSON.stringify({ decisions }),
    }
  )

  if (!response.ok) throw new Error(await readError(response))

  return ((await response.json()) as { review: Review }).review
}

/** Owner-only: the decision that resumes, or stops, the paused workflow. */
export async function settleReview(
  viewId: string,
  action: "approve" | "reject"
): Promise<Review> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders(viewId) },
      body: JSON.stringify({ action }),
    }
  )

  if (!response.ok) throw new Error(await readError(response))

  return ((await response.json()) as { review: Review }).review
}

export type CatalogSearchResult = {
  sku: string
  name: string
  category: string
  manufacturer: string
  unit: string
}

/** Owner-only: the complete catalogue, for when the shortlist was wrong. */
export async function searchCatalog(
  viewId: string,
  query: string
): Promise<CatalogSearchResult[]> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review/catalog?q=${encodeURIComponent(query)}`,
    { headers: ownerHeaders(viewId) }
  )

  if (!response.ok) throw new Error(await readError(response))

  return ((await response.json()) as { products: CatalogSearchResult[] })
    .products
}

export type CustomerSearchResult = {
  customerId: string
  name: string
  tier: string
  city: string | null
}

/** Owner-only: existing customers. There is no path here that creates one. */
export async function searchCustomers(
  viewId: string,
  query: string
): Promise<CustomerSearchResult[]> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review/customers?q=${encodeURIComponent(query)}`,
    { headers: ownerHeaders(viewId) }
  )

  if (!response.ok) throw new Error(await readError(response))

  return ((await response.json()) as { customers: CustomerSearchResult[] })
    .customers
}

/** The canonical quote download. Any holder of the run URL may read it. */
export function quoteDownloadUrl(viewId: string): string {
  return `/api/runs/${encodeURIComponent(viewId)}/quote`
}

/** Owner-only: what the fixed webhook would send, before anything is sent. */
export async function fetchAdapterPreview(
  viewId: string
): Promise<{ payload: unknown; adapter: DeliveryAdapter }> {
  const capability = readOwnerCapability(viewId)
  if (!capability) throw new Error("This browser does not own this run")

  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/delivery/preview`,
    { headers: { authorization: `Bearer ${capability}` } }
  )

  if (!response.ok) throw new Error(await readError(response))

  return (await response.json()) as {
    payload: unknown
    adapter: DeliveryAdapter
  }
}

/** Owner-only: runs the simulated delivery. Nothing leaves the application. */
export async function deliverQuote(viewId: string): Promise<void> {
  const capability = readOwnerCapability(viewId)
  if (!capability) throw new Error("This browser does not own this run")

  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/deliver`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
      },
    }
  )

  if (!response.ok) throw new Error(await readError(response))
}

/** Reads server state. The owner capability is sent only when this browser holds it. */
export async function fetchRun(viewId: string): Promise<RunView> {
  const capability = readOwnerCapability(viewId)
  const response = await fetch(`/api/runs/${encodeURIComponent(viewId)}`, {
    headers: capability ? { authorization: `Bearer ${capability}` } : undefined,
  })

  if (response.status === 404) throw new RunNotFoundError()
  if (!response.ok) throw new Error(await readError(response))

  return (await response.json()) as RunView
}

export async function resetRun(viewId: string): Promise<void> {
  const capability = readOwnerCapability(viewId)
  if (!capability) throw new Error("This browser does not own this run")

  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/reset`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${capability}` },
    }
  )

  if (!response.ok) throw new Error(await readError(response))
}
