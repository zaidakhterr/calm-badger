import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

type RunStep = {
  key: string
  title: string
  position: number
  status: string
  summary: string
  startedAt: string | null
  completedAt: string | null
}

type Run = {
  viewId: string
  status: string
  workflowState: string
  source: { kind: string; scenarioId: string | null }
  createdAt: string
  updatedAt: string
  steps: RunStep[]
}

type RunResponseBody = {
  run: Run
  viewer: { isOwner: boolean; access: string; canMutate: boolean }
  ownerCapability?: string
}

const base = "https://example.test"

async function createRun(scenarioId = "messy-forwarded-request") {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)
  const body = await response.json<RunResponseBody>()

  return body
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

describe("creating an RFQ run", () => {
  it("returns an unguessable view identifier and a one-time owner capability", async () => {
    const first = await createRun()
    const second = await createRun()

    expect(first.run.viewId).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(first.run.viewId).not.toBe(second.run.viewId)
    expect(first.ownerCapability).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(first.ownerCapability).not.toBe(first.run.viewId)
    expect(first.ownerCapability).not.toBe(second.ownerCapability)
    expect(first.viewer).toEqual({
      isOwner: true,
      access: "owner",
      canMutate: true,
    })

    // The capability is returned once: a later read never repeats it.
    const reread = await exports.default.fetch(
      `${base}/api/runs/${first.run.viewId}`,
      { headers: { authorization: `Bearer ${first.ownerCapability}` } }
    )

    expect(Object.keys(await reread.json<RunResponseBody>())).toEqual([
      "run",
      "viewer",
    ])
  })

  it("persists only the capability hash", async () => {
    const { run, ownerCapability } = await createRun()

    const row = await env.DB.prepare(
      `SELECT owner_capability_hash FROM runs WHERE view_id = ?`
    )
      .bind(run.viewId)
      .first<{ owner_capability_hash: string }>()

    expect(row?.owner_capability_hash).toBeDefined()
    expect(row?.owner_capability_hash).not.toBe(ownerCapability)
    expect(row?.owner_capability_hash).toBe(await sha256Hex(ownerCapability!))
  })

  it("rejects an unknown scenario", async () => {
    const response = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "not-a-scenario" }),
    })

    expect(response.status).toBe(400)
  })
})

describe("revisiting a persisted run", () => {
  it("records RFQ receipt as the first completed business step", async () => {
    const { run } = await createRun()

    expect(run.status).toBe("active")
    expect(run.steps.map((step) => step.title)).toEqual([
      "RFQ received",
      "Read documents",
      "Structure RFQ",
      "Resolve customer",
      "Retrieve candidates",
      "Match products",
      "Build estimate",
      "Deliver",
    ])

    const [received, documents, ...later] = run.steps
    expect(received.status).toBe("complete")
    expect(received.completedAt).not.toBeNull()
    // Reading documents is queued immediately, so only the steps behind it are
    // guaranteed to still be waiting.
    expect(["waiting", "active", "complete"]).toContain(documents.status)
    expect(later.every((step) => step.status === "waiting")).toBe(true)
  })

  it("recovers the same server state on a later request", async () => {
    const { run, ownerCapability } = await createRun()

    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}`,
      { headers: { authorization: `Bearer ${ownerCapability}` } }
    )
    const body = await response.json<RunResponseBody>()

    expect(response.status).toBe(200)
    expect(body.run.viewId).toBe(run.viewId)
    expect(body.run.createdAt).toBe(run.createdAt)
    expect(body.run.steps[0]).toMatchObject({
      key: "rfq-received",
      status: "complete",
    })
    expect(body.viewer.isOwner).toBe(true)
  })

  it("is durably acknowledged by the workflow orchestrator", async () => {
    const { run } = await createRun()

    // The orchestrator acknowledges receipt and then continues, so the durable
    // evidence is that the run has left its pending state on its own.
    let workflowState = run.workflowState
    for (
      let attempt = 0;
      attempt < 50 && workflowState === "pending";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      const row = await env.DB.prepare(
        `SELECT workflow_state FROM runs WHERE view_id = ?`
      )
        .bind(run.viewId)
        .first<{ workflow_state: string }>()
      workflowState = row?.workflow_state ?? workflowState
    }

    expect(workflowState).not.toBe("pending")
    expect(workflowState).not.toBe("failed")

    const instanceRow = await env.DB.prepare(
      `SELECT workflow_instance_id FROM runs WHERE view_id = ?`
    )
      .bind(run.viewId)
      .first<{ workflow_instance_id: string }>()

    const instance = await env.RFQ_WORKFLOW.get(
      instanceRow!.workflow_instance_id
    )
    expect(["running", "complete"]).toContain((await instance.status()).status)
  })

  it("returns a not-found state for an unknown run", async () => {
    const response = await exports.default.fetch(
      `${base}/api/runs/definitely-not-a-real-run`
    )

    expect(response.status).toBe(404)
  })
})

describe("sharing a run URL", () => {
  it("gives a URL-only visitor the allowlisted read-only projection", async () => {
    const { run } = await createRun()

    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}`
    )
    const body = await response.json<RunResponseBody>()

    expect(response.status).toBe(200)
    expect(body.viewer).toEqual({
      isOwner: false,
      access: "shared",
      canMutate: false,
    })
    expect(Object.keys(body.run).sort()).toEqual([
      "createdAt",
      "source",
      "status",
      "steps",
      "updatedAt",
      "viewId",
      "workflowState",
    ])
    expect(Object.keys(body.run.steps[0]).sort()).toEqual([
      "completedAt",
      "key",
      "position",
      "startedAt",
      "status",
      "summary",
      "title",
    ])
    expect(JSON.stringify(body)).not.toContain("capability")
  })
})

describe("owner-only mutations", () => {
  it("rejects the public view identifier as authorization", async () => {
    const { run } = await createRun()

    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/reset`,
      { method: "POST", headers: { authorization: `Bearer ${run.viewId}` } }
    )

    expect(response.status).toBe(403)

    const stillThere = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}`
    )
    expect(stillThere.status).toBe(200)
  })

  it("rejects an unauthenticated mutation", async () => {
    const { run } = await createRun()

    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/reset`,
      { method: "POST" }
    )

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer")
  })

  it("rejects a capability scoped to a different run", async () => {
    const target = await createRun()
    const other = await createRun("routine-replenishment")

    const response = await exports.default.fetch(
      `${base}/api/runs/${target.run.viewId}/reset`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${other.ownerCapability}` },
      }
    )

    expect(response.status).toBe(403)
  })

  it("accepts the correctly scoped owner capability and deletes the run", async () => {
    const { run, ownerCapability } = await createRun()

    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/reset`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ownerCapability}` },
      }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "deleted" })

    const afterReset = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}`
    )
    expect(afterReset.status).toBe(404)

    const steps = await env.DB.prepare(
      `SELECT COUNT(*) AS remaining FROM run_steps
        WHERE run_id NOT IN (SELECT id FROM runs)`
    ).first<{ remaining: number }>()
    expect(steps?.remaining).toBe(0)
  })
})
