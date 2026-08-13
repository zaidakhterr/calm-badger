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

export async function createRun(scenarioId: string): Promise<{
  run: Run
  viewer: Viewer
  ownerCapability: string
}> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

  if (!response.ok) throw new Error(await readError(response))

  return (await response.json()) as {
    run: Run
    viewer: Viewer
    ownerCapability: string
  }
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
