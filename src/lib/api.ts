import { readOwnerCapability } from "@/lib/run-store"

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
    estimatedCostUsd: number
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

/** Mirrors the Worker's upload policy so a rejected file never leaves the browser. */
export const UPLOAD_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 6,
  accept: ["application/pdf", "image/jpeg", "image/png"],
  acceptAttribute: ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png",
} as const

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

export async function fetchScenarios(): Promise<Scenario[]> {
  const response = await fetch("/api/scenarios")

  if (!response.ok) throw new Error(await readError(response))

  const body = (await response.json()) as { scenarios: Scenario[] }
  return body.scenarios
}

type CreatedRun = { run: Run; viewer: Viewer; ownerCapability: string }

export async function createRun(scenarioId: string): Promise<CreatedRun> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

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

  const response = await fetch("/api/runs", { method: "POST", body: form })

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
