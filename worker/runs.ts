/**
 * Persisted RFQ runs.
 *
 * A run is addressed publicly by an unguessable `viewId`. Anyone holding that
 * identifier may read the allowlisted projection below. Owner authority is a
 * separate 32-byte capability that is returned exactly once at creation; only
 * its SHA-256 hash is persisted, and it is the sole authorization accepted by
 * mutation endpoints.
 */

import { SCENARIO_IDS, isScenarioId, type ScenarioId } from "./scenarios"
import {
  curatedSources,
  deleteStoredSources,
  storeSources,
  type PreparedSource,
} from "./sources"

export { SCENARIO_IDS, isScenarioId }
export type { ScenarioId }

export type RunStepStatus =
  "waiting" | "active" | "complete" | "review_required" | "error"

/**
 * The always-present business steps of the linear workflow. `Review required`
 * is conditional and is inserted by the review slice, so it is not seeded here.
 */
const WORKFLOW_STEPS = [
  {
    key: "rfq-received",
    title: "RFQ received",
    waiting: "Waiting for a request.",
  },
  {
    key: "read-documents",
    title: "Read documents",
    waiting: "Waiting to read the email, image, and PDF sources.",
  },
  {
    key: "structure-rfq",
    title: "Structure RFQ",
    waiting: "Waiting for validated document text.",
  },
  {
    key: "resolve-customer",
    title: "Resolve customer",
    waiting: "Waiting for structured customer evidence.",
  },
  {
    key: "retrieve-candidates",
    title: "Retrieve candidates",
    waiting: "Waiting for extracted line items.",
  },
  {
    key: "match-products",
    title: "Match products",
    waiting: "Waiting for the bounded candidate shortlist.",
  },
  {
    key: "build-estimate",
    title: "Build estimate",
    waiting: "Waiting for confirmed customer and product matches.",
  },
  {
    key: "deliver",
    title: "Deliver",
    waiting: "Waiting for the canonical quote.",
  },
  {
    key: "delivered",
    title: "Delivered",
    waiting: "The simulated external estimate finishes here.",
  },
] as const

export const RFQ_RECEIVED_STEP_KEY = WORKFLOW_STEPS[0].key

export type RunStepProjection = {
  key: string
  title: string
  position: number
  status: RunStepStatus
  summary: string
  startedAt: string | null
  completedAt: string | null
}

/** The allowlisted read-only projection returned to any holder of a view URL. */
export type RunProjection = {
  viewId: string
  status: string
  workflowState: string
  source: { kind: string; scenarioId: string | null }
  createdAt: string
  updatedAt: string
  steps: RunStepProjection[]
}

export type CreatedRun = {
  runId: string
  run: RunProjection
  /** Plaintext owner capability. Returned once and never persisted. */
  ownerCapability: string
}

type RunRow = {
  id: string
  view_id: string
  owner_capability_hash: string
  source_kind: string
  scenario_id: string | null
  status: string
  workflow_state: string
  created_at: string
  updated_at: string
}

type StepRow = {
  step_key: string
  title: string
  position: number
  status: string
  summary: string
  started_at: string | null
  completed_at: string | null
}

function randomToken(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

export async function hashCapability(capability: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(capability)
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * What a run was started from. Curated sources are read out of the shipped
 * scenario assets; custom sources are already validated upload bytes.
 */
export type RunInput =
  | { kind: "curated"; scenarioId: ScenarioId; requestUrl: string }
  | { kind: "custom"; sources: PreparedSource[] }

export async function createRun(
  env: Env,
  input: RunInput
): Promise<CreatedRun> {
  const runId = crypto.randomUUID()
  const viewId = randomToken(16)
  const ownerCapability = randomToken(32)
  const ownerCapabilityHash = await hashCapability(ownerCapability)
  const now = new Date().toISOString()

  // Sources are read before the run exists so that a missing curated asset
  // fails without leaving an empty run behind.
  const sources =
    input.kind === "curated"
      ? await curatedSources(env, input.scenarioId, input.requestUrl)
      : input.sources

  const statements = [
    env.DB.prepare(
      `INSERT INTO runs (
         id, view_id, owner_capability_hash, source_kind, scenario_id,
         status, workflow_instance_id, workflow_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', NULL, 'pending', ?, ?)`
    ).bind(
      runId,
      viewId,
      ownerCapabilityHash,
      input.kind,
      input.kind === "curated" ? input.scenarioId : null,
      now,
      now
    ),
    ...WORKFLOW_STEPS.map((step, index) => {
      const isReceived = step.key === RFQ_RECEIVED_STEP_KEY

      return env.DB.prepare(
        `INSERT INTO run_steps (
           id, run_id, step_key, position, title, status, summary,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        runId,
        step.key,
        index,
        step.title,
        isReceived ? "complete" : "waiting",
        isReceived
          ? `Stored ${sources.length} ${sources.length === 1 ? "source" : "sources"} and queued the request.`
          : step.waiting,
        isReceived ? now : null,
        isReceived ? now : null,
        now
      )
    }),
  ]

  await env.DB.batch(statements)
  await storeSources(env, runId, sources, now)

  const instance = await env.RFQ_WORKFLOW.create({ params: { runId } })
  await env.DB.prepare(
    `UPDATE runs SET workflow_instance_id = ?, updated_at = ? WHERE id = ?`
  )
    .bind(instance.id, new Date().toISOString(), runId)
    .run()

  const run = await loadRun(env, viewId)
  if (!run) throw new Error("The created run could not be read back")

  return { runId, run, ownerCapability }
}

export async function loadRun(
  env: Env,
  viewId: string
): Promise<RunProjection | null> {
  const row = await env.DB.prepare(
    `SELECT id, view_id, owner_capability_hash, source_kind, scenario_id,
            status, workflow_state, created_at, updated_at
       FROM runs WHERE view_id = ?`
  )
    .bind(viewId)
    .first<RunRow>()

  if (!row) return null

  const steps = await env.DB.prepare(
    `SELECT step_key, title, position, status, summary, started_at, completed_at
       FROM run_steps WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(row.id)
    .all<StepRow>()

  return {
    viewId: row.view_id,
    status: row.status,
    workflowState: row.workflow_state,
    source: { kind: row.source_kind, scenarioId: row.scenario_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    steps: steps.results.map((step) => ({
      key: step.step_key,
      title: step.title,
      position: step.position,
      status: step.status as RunStepStatus,
      summary: step.summary,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
  }
}

export type OwnerAuthorization =
  | { ok: true; runId: string; viewId: string }
  | { ok: false; reason: "missing" | "unknown_run" | "forbidden" }

/**
 * Resolves owner authority for a mutation. The public view identifier is never
 * accepted: authority requires the capability whose hash is stored on this
 * exact run.
 */
export async function authorizeOwner(
  env: Env,
  viewId: string,
  authorization: string | null
): Promise<OwnerAuthorization> {
  const capability = readBearerToken(authorization)
  if (!capability) return { ok: false, reason: "missing" }

  const row = await env.DB.prepare(
    `SELECT id, owner_capability_hash FROM runs WHERE view_id = ?`
  )
    .bind(viewId)
    .first<{ id: string; owner_capability_hash: string }>()

  if (!row) return { ok: false, reason: "unknown_run" }

  const presented = await hashCapability(capability)
  if (presented !== row.owner_capability_hash) {
    return { ok: false, reason: "forbidden" }
  }

  return { ok: true, runId: row.id, viewId }
}

export async function isOwnerRequest(
  env: Env,
  viewId: string,
  authorization: string | null
): Promise<boolean> {
  if (!readBearerToken(authorization)) return false
  const result = await authorizeOwner(env, viewId, authorization)
  return result.ok
}

/** Resolves the internal run identifier behind a public view identifier. */
export async function resolveRunId(
  env: Env,
  viewId: string
): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
    .bind(viewId)
    .first<{ id: string }>()

  return row?.id ?? null
}

/** Deletes the stored originals first, then every persisted record. */
export async function deleteRun(env: Env, runId: string): Promise<void> {
  await deleteStoredSources(env, runId)

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM run_source_pages WHERE run_id = ?`).bind(runId),
    env.DB.prepare(`DELETE FROM run_sources WHERE run_id = ?`).bind(runId),
    env.DB.prepare(`DELETE FROM run_step_evidence WHERE run_id = ?`).bind(
      runId
    ),
    env.DB.prepare(`DELETE FROM run_steps WHERE run_id = ?`).bind(runId),
    env.DB.prepare(`DELETE FROM runs WHERE id = ?`).bind(runId),
  ])
}

function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null
  const match = /^Bearer (.+)$/.exec(authorization.trim())
  return match ? match[1].trim() || null : null
}
