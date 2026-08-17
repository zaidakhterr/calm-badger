/**
 * Contract for applying a customer the owner chose during review.
 *
 * The run is created through the public boundary with the deterministic
 * contract-fake providers selected in `vitest.config.ts`, then the apply
 * function is called directly — that is the interface the workflow uses once
 * the owner has decided.
 */

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { applyReviewCustomer } from "../worker/resolve-customer"

const base = "https://example.test"

type RunStep = { key: string; status: string }
type Run = { viewId: string; steps: RunStep[] }

type ResolutionRow = {
  state: string
  customer_id: string | null
  contact_id: string | null
  location_id: string | null
  confidence_label: string
  confidence_score: number
}

async function createCuratedRun(scenarioId: string) {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)
  return (await response.json<{ run: Run }>()).run
}

async function waitForStep(viewId: string, stepKey: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
    const { run } = await response.json<{ run: Run }>()
    const step = run.steps.find((candidate) => candidate.key === stepKey)!

    if (step.status === "complete" || step.status === "error") return

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Step ${stepKey} never settled`)
}

async function runIdOf(viewId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
    .bind(viewId)
    .first<{ id: string }>()

  return row!.id
}

async function readResolution(runId: string): Promise<ResolutionRow | null> {
  return env.DB.prepare(
    `SELECT state, customer_id, contact_id, location_id,
            confidence_label, confidence_score
       FROM run_customer_resolution WHERE run_id = ?`
  )
    .bind(runId)
    .first<ResolutionRow>()
}

async function resolutionCount(runId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM run_customer_resolution WHERE run_id = ?`
  )
    .bind(runId)
    .first<{ count: number }>()

  return row!.count
}

async function firstContactId(customerId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM catalog_customer_contacts
      WHERE customer_id = ? ORDER BY id ASC LIMIT 1`
  )
    .bind(customerId)
    .first<{ id: string }>()

  return row?.id ?? null
}

async function firstLocationId(customerId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM catalog_customer_locations
      WHERE customer_id = ? ORDER BY id ASC LIMIT 1`
  )
    .bind(customerId)
    .first<{ id: string }>()

  return row?.id ?? null
}

/** A run that resolved to someone else, so the apply has to overwrite. */
async function runResolvedElsewhere(chosen: string): Promise<string> {
  const run = await createCuratedRun("routine-replenishment")
  await waitForStep(run.viewId, "resolve-customer")

  const runId = await runIdOf(run.viewId)
  const before = await readResolution(runId)

  expect(before!.customer_id).not.toBe(chosen)
  return runId
}

/* -------------------------------------------------------------------------- */

describe("applying the customer chosen in review", () => {
  const chosen = "CUST-1002"

  it("records the chosen customer as resolved at full confidence", async () => {
    const runId = await runResolvedElsewhere(chosen)

    await applyReviewCustomer(env, runId, { customerId: chosen })

    expect(await readResolution(runId)).toEqual({
      state: "resolved",
      customer_id: chosen,
      contact_id: await firstContactId(chosen),
      location_id: await firstLocationId(chosen),
      confidence_label: "High",
      confidence_score: 1,
    })
  })

  it("defaults the contact and location to the customer's first records", async () => {
    const runId = await runResolvedElsewhere(chosen)

    await applyReviewCustomer(env, runId, { customerId: chosen })
    const row = await readResolution(runId)

    const contacts = await env.DB.prepare(
      `SELECT id FROM catalog_customer_contacts WHERE customer_id = ?
        ORDER BY id ASC`
    )
      .bind(chosen)
      .all<{ id: string }>()

    expect(contacts.results.length).toBeGreaterThan(0)
    expect(row!.contact_id).toBe(contacts.results[0].id)
    expect(row!.location_id).not.toBeNull()
  })

  it("leaves a single row when applied twice", async () => {
    const runId = await runResolvedElsewhere(chosen)

    await applyReviewCustomer(env, runId, { customerId: chosen })
    const first = await readResolution(runId)

    await applyReviewCustomer(env, runId, { customerId: chosen })

    expect(await resolutionCount(runId)).toBe(1)
    expect(await readResolution(runId)).toEqual(first)
  })

  it("refuses an unknown customer rather than resolving to nothing", async () => {
    const runId = await runResolvedElsewhere(chosen)
    const before = await readResolution(runId)

    await expect(
      applyReviewCustomer(env, runId, { customerId: "CUST-NOPE" })
    ).rejects.toThrow(/CUST-NOPE/)

    expect(await readResolution(runId)).toEqual(before)
  })
})
