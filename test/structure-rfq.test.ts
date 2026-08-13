/**
 * Contract for structuring an RFQ and resolving its customer.
 *
 * These tests drive the public workflow boundary — create a run, wait for the
 * persisted steps, read the evidence projections — with the deterministic
 * contract-fake OCR and extraction providers selected in `vitest.config.ts`. No
 * test reaches a live provider, and none of them assert prompt wording or
 * internal calls. The fake extractor derives its answer from the document text
 * alone, so the repair, schema, and business-validation paths below are the
 * real ones.
 */

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { selectExtractionProvider } from "../worker/providers/extraction"
import { resolveCustomer } from "../worker/resolve-customer"
import {
  applyBusinessRules,
  parseModelOutput,
  repairJson,
  RFQ_EXTRACTION_INSTRUCTION,
  validateAgainstSchema,
} from "../worker/rfq-extraction"
import { SCENARIOS } from "../worker/scenarios"
import { structureRfq } from "../worker/structure-rfq"
import { goldScenario } from "./fixtures/gold-scenarios"

const base = "https://example.test"

function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides }
}

type RunStep = { key: string; status: string; summary: string }
type Run = {
  viewId: string
  status: string
  workflowState: string
  steps: RunStep[]
}

type StructureEvidence = {
  stepKey: string
  state: string
  message: string | null
  validated: {
    customer: {
      companyName: string | null
      contactName: string | null
      contactEmail: string | null
      deliveryLocation: string | null
    }
    source: { channel: string; subject: string | null; references: string[] }
    deadline: { date: string | null; text: string | null }
    lineItems: {
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
    }[]
  } | null
  confidence: { label: string; score: number; heuristic: string } | null
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

type CustomerEvidence = {
  stepKey: string
  state: string
  message: string | null
  method: string | null
  resolution: {
    customerId: string
    name: string
    tier: string
    contact: { id: string; name: string; email: string } | null
    location: { id: string; label: string; city: string } | null
  } | null
  confidence: { label: string; score: number; heuristic: string } | null
  signals: { kind: string; detail: string; weight: number }[]
  candidates: { customerId: string; name: string; score: number }[]
  inputs: {
    contactEmail: string | null
    companyName: string | null
    deliveryLocation: string | null
    referenceCount: number
  } | null
  metrics: { elapsedMs: number } | null
}

async function createCuratedRun(scenarioId: string) {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)
  return response.json<{ run: Run }>()
}

async function createCustomRun(emailBody: string) {
  const form = new FormData()
  form.set("emailBody", emailBody)

  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    body: form,
  })

  expect(response.status).toBe(201)
  return response.json<{ run: Run }>()
}

async function waitForStep(
  viewId: string,
  stepKey: string,
  statuses: string[]
): Promise<RunStep> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
    const { run } = await response.json<{ run: Run }>()
    const step = run.steps.find((candidate) => candidate.key === stepKey)!

    if (statuses.includes(step.status)) return step

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Step ${stepKey} never reached ${statuses.join(" or ")}`)
}

async function readStructure(viewId: string): Promise<StructureEvidence> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/structure`
  )

  expect(response.status).toBe(200)
  return (await response.json<{ evidence: StructureEvidence }>()).evidence
}

async function readCustomer(viewId: string): Promise<CustomerEvidence> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/customer`
  )

  expect(response.status).toBe(200)
  return (await response.json<{ evidence: CustomerEvidence }>()).evidence
}

async function readRun(viewId: string): Promise<Run> {
  const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
  return (await response.json<{ run: Run }>()).run
}

async function runIdOf(viewId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
    .bind(viewId)
    .first<{ id: string }>()

  return row!.id
}

/* -------------------------------------------------------------------------- */

describe("structuring a curated request", () => {
  it("validates every line of a request that quotes article numbers", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    const step = await waitForStep(run.viewId, "structure-rfq", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("complete")
    expect(step.summary).toContain("Validated 6 lines")

    const evidence = await readStructure(run.viewId)

    expect(evidence.state).toBe("complete")
    expect(evidence.repaired).toBe(false)
    expect(evidence.issues).toEqual([])

    const validated = evidence.validated!
    expect(validated.customer.contactEmail).toBe(
      "lena.vogt@northline-services.example"
    )
    expect(validated.customer.companyName).toBe("Northline Property Services")
    expect(validated.customer.deliveryLocation).toContain("Spandau")
    expect(validated.source.channel).toBe("mixed")
    expect(validated.source.references).toContain("replenishment-list.pdf")

    expect(validated.lineItems).toHaveLength(6)
    expect(validated.lineItems.map((line) => line.state)).toEqual(
      Array.from({ length: 6 }, () => "accepted")
    )
    expect(validated.lineItems[0]).toMatchObject({
      position: 1,
      catalogSku: "NX-FLT-1120",
      quantity: 24,
      unit: "pieces",
    })
    // Provenance survives: every fact says which document and page it came from.
    for (const line of validated.lineItems) {
      expect(line.sourceLabel.length).toBeGreaterThan(0)
      expect(line.sourcePage).toBe(1)
    }
  })

  it("carries quantities that only the covering email states", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "structure-rfq", ["complete", "error"])

    const validated = (await readStructure(run.viewId)).validated!

    expect(validated.lineItems).toHaveLength(6)
    // The attached list has no amounts; the forwarded note does.
    expect(validated.lineItems.map((line) => line.quantity)).not.toContain(null)
    expect(validated.deadline.text).toBe("next week")
  })

  it("exposes the confidence label, heuristic, model, latency, tokens, and cost", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "structure-rfq", ["complete", "error"])

    const evidence = await readStructure(run.viewId)

    expect(["High", "Medium", "Review"]).toContain(evidence.confidence!.label)
    expect(evidence.confidence!.score).toBeGreaterThan(0)
    expect(evidence.confidence!.heuristic).toContain("starts at 1.00")
    expect(evidence.provider).toBe("contract-fake")
    expect(evidence.model).toContain("contract-fake")
    expect(evidence.metrics!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(evidence.metrics!.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(evidence.usage!.totalTokens).toBeGreaterThan(0)
    expect(evidence.usage!.totalTokens).toBe(
      evidence.usage!.inputTokens + evidence.usage!.outputTokens
    )
    expect(evidence.estimatedCostUsd).toBeGreaterThan(0)
  })

  it("shows the validated result before the original model output", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "structure-rfq", ["complete", "error"])

    const evidence = await readStructure(run.viewId)
    const keys = Object.keys(evidence)

    expect(keys.indexOf("validated")).toBeLessThan(
      keys.indexOf("originalOutput")
    )
    expect(evidence.originalOutput).toContain("lineItems")
  })

  it("gives a shared viewer the same evidence as the owner", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "resolve-customer", ["complete", "error"])

    for (const segment of ["structure", "customer"]) {
      const owned = await exports.default.fetch(
        `${base}/api/runs/${run.viewId}/${segment}`
      )
      const shared = await exports.default.fetch(
        `${base}/api/runs/${run.viewId}/${segment}`,
        { headers: { authorization: "Bearer not-the-owner" } }
      )

      expect(await owned.text()).toBe(await shared.text())
    }
  })
})

describe("resolving the customer", () => {
  for (const scenario of SCENARIOS) {
    it(`resolves ${scenario.name} to its synthetic customer`, async () => {
      const { run } = await createCuratedRun(scenario.id)
      const step = await waitForStep(run.viewId, "resolve-customer", [
        "complete",
        "error",
      ])

      expect(step.status).toBe("complete")

      const evidence = await readCustomer(run.viewId)
      const gold = goldScenario(scenario.id)

      expect(evidence.state).toBe("resolved")
      expect(evidence.method).toBe("deterministic-catalog-lookup")
      expect(evidence.resolution!.customerId).toBe(gold.customer.customerId)
      expect(evidence.confidence!.label).toBe("High")
      expect(step.summary).toContain(evidence.resolution!.name)
    })
  }

  it("considers identity signals rather than the requested products", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "resolve-customer", ["complete", "error"])

    const evidence = await readCustomer(run.viewId)
    const kinds = evidence.signals.map((signal) => signal.kind)

    expect(kinds).toContain("contact_email")
    expect(kinds).toContain("email_domain")
    expect(kinds).toContain("company_name")
    expect(kinds).toContain("location")
    expect(kinds).toContain("order_history")

    expect(evidence.resolution!.contact!.email).toBe(
      goldScenario("routine-replenishment").customer.contactEmail
    )
    expect(evidence.resolution!.location!.id).toBe(
      goldScenario("routine-replenishment").customer.locationId
    )
    expect(evidence.confidence!.heuristic).toContain("Customer confidence sums")
  })

  it("leaves an unknown sender unresolved and never invents a customer", async () => {
    const before = await customerCount()

    const { run } = await createCustomRun(
      "Hello, please quote 5 replacement lamps. Regards, an unfamiliar buyer"
    )

    const step = await waitForStep(run.viewId, "resolve-customer", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("complete")
    expect(step.summary).toContain("stays unresolved")

    const evidence = await readCustomer(run.viewId)

    expect(evidence.state).toBe("unresolved")
    expect(evidence.resolution).toBeNull()
    expect(evidence.confidence!.label).toBe("Review")
    expect(evidence.message).toContain("never creates a customer record")
    expect(await customerCount()).toBe(before)

    const stored = await env.DB.prepare(
      `SELECT state, customer_id FROM run_customer_resolution WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ state: string; customer_id: string | null }>()

    expect(stored).toEqual({ state: "unresolved", customer_id: null })

    // The run continues; an unresolved customer is a fact, not a failure.
    expect((await readRun(run.viewId)).status).toBe("active")
  })

  it("ends in a terminal error when there is nothing structured to resolve", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "resolve-customer", ["complete", "error"])

    const runId = await runIdOf(run.viewId)
    await env.DB.prepare(`DELETE FROM run_rfq WHERE run_id = ?`)
      .bind(runId)
      .run()

    const outcome = await resolveCustomer(env, runId)
    expect(outcome.state).toBe("error")

    const step = await env.DB.prepare(
      `SELECT status, completed_at FROM run_steps
        WHERE run_id = ? AND step_key = 'resolve-customer'`
    )
      .bind(runId)
      .first<{ status: string; completed_at: string | null }>()

    expect(step!.status).toBe("error")
    expect(step!.completed_at).not.toBeNull()
  })
})

describe("model output that has to be validated", () => {
  it("accepts output that one repair attempt can rescue", async () => {
    const { run } = await createCustomRun(
      [
        "From: Lena Vogt <lena.vogt@northline-services.example>",
        "Company: Northline Property Services",
        "",
        "Please quote 24 NX-FLT-1120 panel filters for the Spandau depot.",
        "trigger-repairable-output",
      ].join("\n")
    )

    const step = await waitForStep(run.viewId, "structure-rfq", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("complete")

    const evidence = await readStructure(run.viewId)

    expect(evidence.repaired).toBe(true)
    expect(evidence.validated!.lineItems[0].catalogSku).toBe("NX-FLT-1120")
    expect(evidence.confidence!.heuristic).toContain("needed repair")
    // The original response is kept exactly as it arrived, damage included.
    expect(evidence.originalOutput).toContain("```json")
  })

  it("stops the run when the output cannot be repaired", async () => {
    const { run } = await createCustomRun(
      "Please quote our list. trigger-unparsable-output"
    )

    const step = await waitForStep(run.viewId, "structure-rfq", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("error")
    expect(step.summary).toContain("not valid JSON")
    expect(step.summary).toContain("One repair attempt was made")

    const stopped = await readRun(run.viewId)
    expect(stopped.status).toBe("error")
    expect(stopped.workflowState).toBe("failed")
    expect(stopped.steps.filter((s) => s.status === "active")).toHaveLength(0)
    // Nothing later may start on output that never validated.
    expect(
      stopped.steps.find((s) => s.key === "resolve-customer")!.status
    ).toBe("waiting")

    const evidence = await readStructure(run.viewId)
    expect(evidence.state).toBe("error")
    expect(evidence.validated).toBeNull()
    expect(evidence.originalOutput).not.toBeNull()

    expect(await lineItemCount(run.viewId)).toBe(0)
  })

  it("stops the run when the output does not match the schema", async () => {
    const { run } = await createCustomRun(
      "Please quote 4 lamps. trigger-schema-violation"
    )

    const step = await waitForStep(run.viewId, "structure-rfq", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("error")
    expect(step.summary).toContain("did not match the required RFQ schema")

    const evidence = await readStructure(run.viewId)
    expect(evidence.issues.length).toBeGreaterThan(0)
    expect(evidence.issues[0]).toContain("lineItems")
    expect(evidence.validated).toBeNull()
    expect(await lineItemCount(run.viewId)).toBe(0)
  })

  it("sends an unusable quantity to review instead of pricing it", async () => {
    const { run } = await createCustomRun(
      "Please quote 24 panel filters for the depot. trigger-invalid-quantity"
    )

    const step = await waitForStep(run.viewId, "structure-rfq", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("complete")
    expect(step.summary).toContain("needing review")

    const line = (await readStructure(run.viewId)).validated!.lineItems[0]

    expect(line.state).toBe("review_required")
    expect(line.quantity).toBeNull()
    expect(line.reason).toContain("not a usable whole number")

    const stored = await env.DB.prepare(
      `SELECT quantity, validation_state FROM run_rfq_line_items
        WHERE run_id = ? AND position = ?`
    )
      .bind(await runIdOf(run.viewId), line.position)
      .first<{ quantity: number | null; validation_state: string }>()

    expect(stored).toEqual({
      quantity: null,
      validation_state: "review_required",
    })
  })

  it("discards an article number that does not exist in the catalogue", async () => {
    const { run } = await createCustomRun(
      "Please quote 8 replacement lamps for the depot. trigger-invented-sku"
    )

    await waitForStep(run.viewId, "structure-rfq", ["complete", "error"])

    const evidence = await readStructure(run.viewId)
    const line = evidence.validated!.lineItems[0]

    expect(line.state).toBe("review_required")
    expect(line.catalogSku).toBeNull()
    expect(line.reason).toContain("does not exist in the catalogue")
    expect(evidence.confidence!.label).not.toBe("High")

    const stored = await env.DB.prepare(
      `SELECT catalog_sku FROM run_rfq_line_items WHERE run_id = ? AND position = ?`
    )
      .bind(await runIdOf(run.viewId), line.position)
      .first<{ catalog_sku: string | null }>()

    expect(stored!.catalog_sku).toBeNull()
  })

  it("stops the run when the extraction provider itself fails", async () => {
    const { run } = await createCustomRun(
      "Please quote the attached list. trigger-extraction-error"
    )

    const step = await waitForStep(run.viewId, "structure-rfq", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("error")
    expect(step.summary).toContain("extraction model")

    const stopped = await readRun(run.viewId)
    expect(stopped.status).toBe("error")
    expect(stopped.steps.filter((s) => s.status === "active")).toHaveLength(0)

    const evidence = await readStructure(run.viewId)
    expect(evidence.state).toBe("error")
    expect(JSON.stringify(evidence)).not.toContain("Bearer")
    expect(JSON.stringify(evidence)).not.toContain("openrouter.ai")
  })

  it("ends in a terminal error when the provider cannot even be selected", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "structure-rfq", ["complete", "error"])

    const runId = await runIdOf(run.viewId)
    const outcome = await structureRfq(
      envWith({ EXTRACTION_PROVIDER: "contract-fake", APP_ENV: "production" }),
      runId
    )

    expect(outcome.state).toBe("error")

    const step = await env.DB.prepare(
      `SELECT status, completed_at FROM run_steps
        WHERE run_id = ? AND step_key = 'structure-rfq'`
    )
      .bind(runId)
      .first<{ status: string; completed_at: string | null }>()

    expect(step!.status).toBe("error")
    expect(step!.completed_at).not.toBeNull()

    const stopped = await env.DB.prepare(
      `SELECT status, workflow_state FROM runs WHERE id = ?`
    )
      .bind(runId)
      .first<{ status: string; workflow_state: string }>()

    expect(stopped).toEqual({ status: "error", workflow_state: "failed" })
  })
})

describe("validation in isolation", () => {
  const valid = {
    customer: {
      companyName: "Northline Property Services",
      contactName: "Lena Vogt",
      contactEmail: "lena.vogt@northline-services.example",
      contactPhone: null,
      deliveryLocation: "Spandau service depot",
    },
    source: {
      channel: "mixed",
      subject: "Replenishment",
      receivedAt: null,
      references: ["replenishment-list.pdf"],
    },
    deadline: { date: null, text: null },
    lineItems: [
      {
        position: 1,
        reference: "NX-FLT-1120",
        description: "Panel filter",
        quantity: 24,
        unit: "pieces",
        catalogSku: "NX-FLT-1120",
        sourceLabel: "replenishment-list.pdf",
        sourcePage: 1,
      },
    ],
  }

  it("accepts well-formed output unchanged", () => {
    const parsed = parseModelOutput(JSON.stringify(valid))
    expect(parsed).toMatchObject({ state: "parsed", repaired: false })

    const checked = validateAgainstSchema(
      parsed.state === "parsed" ? parsed.value : null
    )
    expect(checked.state).toBe("valid")
  })

  it("makes exactly one repair attempt at damaged JSON", () => {
    const damaged = `Sure!\n\`\`\`json\n${JSON.stringify(valid, null, 2).replace(/\n\}$/, ",\n}")}\n\`\`\``
    const parsed = parseModelOutput(damaged)

    expect(parsed).toMatchObject({ state: "parsed", repaired: true })
    // The repair is deterministic and local; it never calls a provider again.
    expect(repairJson("not json at all")).toBeNull()
  })

  it("refuses output that no repair can rescue", () => {
    expect(parseModelOutput("I could not read the documents.").state).toBe(
      "irreparable"
    )
    expect(parseModelOutput("").state).toBe("irreparable")
  })

  it("reports schema failures by path and rule only", () => {
    const checked = validateAgainstSchema({ ...valid, lineItems: "none" })

    expect(checked.state).toBe("invalid")
    if (checked.state !== "invalid") return
    expect(checked.issues.join(" ")).toContain("lineItems")
    // The rejected value is model text and must not travel with the issue.
    expect(checked.issues.join(" ")).not.toContain("none")
  })

  it("strips invented references and unusable quantities", () => {
    const checked = validateAgainstSchema({
      ...valid,
      lineItems: [
        { ...valid.lineItems[0], catalogSku: "NX-ZZZ-9999" },
        { ...valid.lineItems[0], position: 2, quantity: 0 },
        { ...valid.lineItems[0], position: 3, quantity: 2.5 },
      ],
    })

    expect(checked.state).toBe("valid")
    if (checked.state !== "valid") return

    const validated = applyBusinessRules(checked.rfq, new Set(["NX-FLT-1120"]))

    expect(validated.lineItems[0]).toMatchObject({
      catalogSku: null,
      state: "review_required",
    })
    expect(validated.lineItems[1]).toMatchObject({
      quantity: null,
      state: "review_required",
    })
    expect(validated.lineItems[2]).toMatchObject({
      quantity: null,
      state: "review_required",
    })
  })
})

describe("selecting the extraction provider", () => {
  it("refuses to build the contract fake in production", () => {
    expect(() =>
      selectExtractionProvider(
        envWith({ EXTRACTION_PROVIDER: "contract-fake", APP_ENV: "production" })
      )
    ).toThrow(/not allowed in production/)
  })

  it("builds the contract fake outside production", () => {
    const provider = selectExtractionProvider(
      envWith({ EXTRACTION_PROVIDER: "contract-fake", APP_ENV: "test" })
    )

    expect(provider.name).toBe("contract-fake")
  })
})

describe("what leaves the system", () => {
  it("keeps secrets, prompts, and expected-outcome copy out of the evidence", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "resolve-customer", ["complete", "error"])

    const serialized = JSON.stringify([
      await readStructure(run.viewId),
      await readCustomer(run.viewId),
    ])

    for (const forbidden of [
      "authorization",
      "Bearer",
      "openrouter.ai",
      "api.mistral.ai",
      "apiKey",
      "capability",
      "storageKey",
      // The instruction is a system prompt and is never shown.
      "You extract request-for-quotation facts",
    ]) {
      expect(serialized).not.toContain(forbidden)
    }

    // The landing page's line notes describe the expected answer.
    for (const leaked of [
      "Matches a known alias exactly",
      "Typographical variant of a stocked panel filter",
      "Legacy number for an archived seal kit",
      "Fits both the 2 mm and the 3 mm gasket",
    ]) {
      expect(serialized).not.toContain(leaked)
    }
  })

  it("never sends the scenario's expected-outcome copy to the model", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "structure-rfq", ["complete", "error"])

    // Everything the extractor receives is the instruction plus the text the
    // reader stored, so this is the whole outbound payload.
    const pages = await env.DB.prepare(
      `SELECT markdown FROM run_source_pages WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .all<{ markdown: string }>()

    const outbound = [
      RFQ_EXTRACTION_INSTRUCTION,
      ...pages.results.map((page) => page.markdown),
    ].join("\n")

    for (const scenario of SCENARIOS) {
      for (const item of scenario.requestedItems) {
        expect(outbound).not.toContain(item.note)
      }
    }
  })

  it("removes structured facts when the run is reset", async () => {
    const response = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "routine-replenishment" }),
    })

    const { run, ownerCapability } = await response.json<{
      run: Run
      ownerCapability: string
    }>()

    await waitForStep(run.viewId, "resolve-customer", ["complete", "error"])
    const runId = await runIdOf(run.viewId)

    const reset = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/reset`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ownerCapability}` },
      }
    )
    expect(reset.status).toBe(200)

    const remaining = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM run_rfq WHERE run_id = ?1) AS rfq,
         (SELECT COUNT(*) FROM run_rfq_line_items WHERE run_id = ?1) AS lines,
         (SELECT COUNT(*) FROM run_customer_resolution WHERE run_id = ?1) AS customer`
    )
      .bind(runId)
      .first<{ rfq: number; lines: number; customer: number }>()

    expect(remaining).toEqual({ rfq: 0, lines: 0, customer: 0 })
  })
})

async function customerCount(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM catalog_customers`
  ).first<{ total: number }>()

  return row?.total ?? 0
}

async function lineItemCount(viewId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM run_rfq_line_items
      WHERE run_id = (SELECT id FROM runs WHERE view_id = ?)`
  )
    .bind(viewId)
    .first<{ total: number }>()

  return row?.total ?? 0
}
