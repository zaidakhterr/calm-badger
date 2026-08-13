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

export async function fetchDocumentEvidence(
  viewId: string
): Promise<DocumentEvidence> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/documents`
  )

  if (response.status === 404) throw new RunNotFoundError()
  if (!response.ok) throw new Error(await readError(response))

  const body = (await response.json()) as { evidence: DocumentEvidence }
  return body.evidence
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
