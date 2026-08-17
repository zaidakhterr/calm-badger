import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { normaliseText } from "../worker/catalog/retrieval"
import { loadReviewOutcome, settleReview } from "../worker/review"
import { retentionDeadline } from "../worker/retention-policy"

const base = "https://example.test"

type Run = {
  viewId: string
  status: string
  workflowState: string
  steps: {
    key: string
    title: string
    position: number
    status: string
    summary: string
  }[]
}

type ReviewItem = {
  id: string
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
  alternatives: {
    value: string
    label: string
    detail: string
    score: number
  }[]
  state: string
  decision: string | null
  resolved: {
    sku: string | null
    quantity: number | null
    customerId: string | null
    at: string | null
  }
}

type Review = {
  stepKey: string
  state: string
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

async function createRun(scenarioId: string, workspaceId?: string) {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
    },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)
  return response.json<{ run: Run; ownerCapability: string }>()
}

async function readRun(viewId: string): Promise<Run> {
  const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
  return (await response.json<{ run: Run }>()).run
}

async function readReview(viewId: string): Promise<Review> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/review`
  )

  expect(response.status).toBe(200)
  return (await response.json<{ review: Review }>()).review
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  what: string,
  attempts = 200
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Never observed ${what}`)
}

/** A run stopped at the review node, with the node's questions loaded. */
async function pausedRun(workspaceId?: string) {
  const created = await createRun("messy-forwarded-request", workspaceId)

  const run = await waitFor(
    () => readRun(created.run.viewId),
    (value) =>
      value.workflowState === "awaiting_review" ||
      value.workflowState === "failed",
    "a run that stopped for review"
  )

  expect(run.workflowState).toBe("awaiting_review")

  return { ...created, run, review: await readReview(created.run.viewId) }
}

/**
 * A run from an unknown sender, so identity itself is one of the questions.
 * The marker is a contract-fake trigger, which is how a quantity or a field
 * that fails business validation is produced deterministically.
 */
async function customPausedRun(marker: string) {
  const form = new FormData()
  form.set(
    "emailBody",
    [
      "From: procurement@unknown-industrial-example.test",
      "Company: Unknown Industrial Works GmbH",
      "Subject: Request for quotation",
      "",
      "Please quote the following:",
      "10 x panel filter 592x592 G4",
      "4 x LED high bay 150W",
      "",
      marker,
    ].join("\n")
  )

  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    body: form,
  })

  expect(response.status).toBe(201)
  const created = await response.json<{ run: Run; ownerCapability: string }>()

  const run = await waitFor(
    () => readRun(created.run.viewId),
    (value) =>
      value.workflowState === "awaiting_review" ||
      value.workflowState === "estimate_built" ||
      value.workflowState === "failed",
    "a custom run that stopped for review"
  )

  expect(run.workflowState).toBe("awaiting_review")

  return { ...created, run, review: await readReview(created.run.viewId) }
}

function decide(
  viewId: string,
  capability: string | null,
  decisions: unknown[]
) {
  return exports.default.fetch(`${base}/api/runs/${viewId}/review/decisions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(capability ? { authorization: `Bearer ${capability}` } : {}),
    },
    body: JSON.stringify({ decisions }),
  })
}

function settle(viewId: string, capability: string | null, action: string) {
  return exports.default.fetch(`${base}/api/runs/${viewId}/review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(capability ? { authorization: `Bearer ${capability}` } : {}),
    },
    body: JSON.stringify({ action }),
  })
}

/** Accepts every proposal, and supplies the one thing a proposal cannot. */
function straightforwardDecisions(review: Review, customerId = "CUST-1001") {
  return review.items.map((item) => {
    if (item.kind === "quantity") {
      return { itemId: item.id, action: "quantity", quantity: 10 }
    }

    if (item.kind === "customer") {
      return { itemId: item.id, action: "customer", customerId }
    }

    if (item.kind === "product" && !item.proposal.sku) {
      return {
        itemId: item.id,
        action: "alternative",
        sku: item.alternatives[0].value,
      }
    }

    return { itemId: item.id, action: "accept" }
  })
}

async function runIdOf(viewId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
    .bind(viewId)
    .first<{ id: string }>()

  return row!.id
}

function environmentThatFailsBatches(): Env {
  const database: D1Database = {
    prepare: (query) => env.DB.prepare(query),
    batch: <T = unknown>(
      statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> => {
      void statements
      return Promise.reject(new Error("Forced approval-effects failure"))
    },
    exec: (query) => env.DB.exec(query),
    withSession: (constraintOrBookmark) =>
      env.DB.withSession(constraintOrBookmark),
    dump: () => env.DB.dump(),
  }

  return { ...env, DB: database }
}

function environmentThatExpiresBeforeBatch(runId: string): Env {
  let intercepted = false
  const database: D1Database = {
    prepare: (query) => env.DB.prepare(query),
    batch: async <T = unknown>(
      statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> => {
      if (!intercepted) {
        intercepted = true
        await env.DB.prepare(
          `UPDATE run_reviews SET expires_at = ? WHERE run_id = ?`
        )
          .bind(new Date(Date.now() - 1_000).toISOString(), runId)
          .run()
      }

      return env.DB.batch<T>(statements)
    },
    exec: (query) => env.DB.exec(query),
    withSession: (constraintOrBookmark) =>
      env.DB.withSession(constraintOrBookmark),
    dump: () => env.DB.dump(),
  }

  return { ...env, DB: database }
}

/* -------------------------------------------------------------------------- */
/* Waiting                                                                    */
/* -------------------------------------------------------------------------- */

describe("pausing an uncertain run", () => {
  it("stops at one review node that blocks every later step", async () => {
    const { run, review } = await pausedRun()

    const review_ = run.steps.find((step) => step.key === "review-required")!
    const match = run.steps.find((step) => step.key === "match-products")!
    const estimate = run.steps.find((step) => step.key === "build-estimate")!
    const deliver = run.steps.find((step) => step.key === "deliver")!

    // One node, in the linear sequence, between the decisions it questions and
    // the pricing it blocks.
    expect(
      run.steps.filter((step) => step.key === "review-required")
    ).toHaveLength(1)
    expect(review_.title).toBe("Review required")
    expect(review_.status).toBe("review_required")
    expect(review_.position).toBeGreaterThan(match.position)
    expect(review_.position).toBeLessThan(estimate.position)
    expect(estimate.status).toBe("waiting")
    expect(estimate.summary).toContain("Waiting for owner review")
    expect(deliver.status).toBe("waiting")
    expect(run.status).toBe("active")

    // Nothing was priced or delivered while the node waits.
    const stored = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM run_quotes WHERE run_id = ?1) AS quotes,
              (SELECT COUNT(*) FROM run_deliveries WHERE run_id = ?1) AS deliveries`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ quotes: number; deliveries: number }>()

    expect(stored).toEqual({ quotes: 0, deliveries: 0 })
    expect(review.state).toBe("pending")
    expect(review.items.length).toBeGreaterThan(0)
    expect(review.itemCount).toBe(review.items.length)
    expect(review.canApprove).toBe(false)
  })

  it("shows the source phrase, proposal, confidence, reasons, and alternatives", async () => {
    const { review } = await pausedRun()

    for (const item of review.items) {
      expect(["customer", "product", "quantity", "field"]).toContain(item.kind)
      expect(item.sourcePhrase.length).toBeGreaterThan(0)
      expect(item.proposal.label.length).toBeGreaterThan(0)
      expect(["High", "Medium", "Review"]).toContain(item.confidence.label)
      expect(item.confidence.heuristic.length).toBeGreaterThan(20)
      expect(item.reasons.length).toBeGreaterThan(0)
      expect(item.alternatives.length).toBeLessThanOrEqual(3)
      expect(item.state).toBe("pending")
    }

    const product = review.items.find((item) => item.kind === "product")!

    // The proposal describes the product; it does not repeat the SKU shown
    // beside it, and it does not tell the owner what to do — the button does.
    if (product.proposal.sku) {
      expect(product.proposal.label).not.toMatch(/^propose\b/i)
      expect(product.proposal.label).not.toContain(product.proposal.sku)
    }

    expect(product.alternatives.length).toBeGreaterThan(0)
    for (const alternative of product.alternatives) {
      expect(alternative.value).toMatch(/^[A-Z]/)
      expect(alternative.label.length).toBeGreaterThan(0)
    }

    // The heuristic is described as a demo heuristic, never as certainty.
    expect(review.note).toContain("owner-only")
  })
})

/* -------------------------------------------------------------------------- */
/* Read-only sharing                                                          */
/* -------------------------------------------------------------------------- */

describe("a shared browser", () => {
  it("reads the review but is offered no control over it", async () => {
    const { run, review } = await pausedRun()

    const shared = await exports.default.fetch(`${base}/api/runs/${run.viewId}`)
    const { viewer } = await shared.json<{
      viewer: { isOwner: boolean; canMutate: boolean }
    }>()

    expect(viewer.isOwner).toBe(false)
    expect(viewer.canMutate).toBe(false)
    expect(review.items.length).toBeGreaterThan(0)
  })

  it("cannot decide the review by holding the run URL", async () => {
    const { run, review } = await pausedRun()
    const decisions = straightforwardDecisions(review)

    expect((await decide(run.viewId, null, decisions)).status).toBe(401)
    expect((await decide(run.viewId, "not-the-owner", decisions)).status).toBe(
      403
    )
    expect((await settle(run.viewId, null, "approve")).status).toBe(401)
    expect((await settle(run.viewId, "not-the-owner", "approve")).status).toBe(
      403
    )
    expect(
      (await settle("unknown-view-id", "not-the-owner", "approve")).status
    ).toBe(404)

    // Searching the catalogue is an owner action too, and so is searching
    // customers: both sit behind the same capability gate.
    const search = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/review/catalog?q=filter`
    )

    expect(search.status).toBe(401)

    const customerSearch = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/review/customers?q=works`
    )

    expect(customerSearch.status).toBe(401)

    // Nothing moved.
    const after = await readReview(run.viewId)
    expect(after.state).toBe("pending")
    expect(after.resolvedCount).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Deciding                                                                   */
/* -------------------------------------------------------------------------- */

describe("approving a review", () => {
  it("resumes the hibernating workflow through the same pricing path", async () => {
    const { run, ownerCapability, review } = await pausedRun()

    const recorded = await decide(
      run.viewId,
      ownerCapability,
      straightforwardDecisions(review)
    )

    expect(recorded.status).toBe(200)
    const afterDecisions = (await recorded.json<{ review: Review }>()).review

    expect(afterDecisions.resolvedCount).toBe(afterDecisions.itemCount)
    expect(afterDecisions.canApprove).toBe(true)
    // Recording corrections releases nothing on its own.
    expect(afterDecisions.state).toBe("pending")
    expect((await readRun(run.viewId)).workflowState).toBe("awaiting_review")

    const approved = await settle(run.viewId, ownerCapability, "approve")
    expect(approved.status).toBe(200)

    const settled = await waitFor(
      () => readRun(run.viewId),
      (value) =>
        value.workflowState === "estimate_built" ||
        value.workflowState === "failed",
      "a priced run"
    )

    expect(settled.workflowState).toBe("estimate_built")
    expect(
      settled.steps.find((step) => step.key === "review-required")!.status
    ).toBe("complete")
    expect(
      settled.steps.find((step) => step.key === "build-estimate")!.status
    ).toBe("complete")

    // The quote priced the corrected facts, through the same deterministic
    // rules an untouched run uses.
    const quote = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/quote`
    )
    const document = await quote.json<{
      customer: { customerId: string }
      lines: {
        position: number
        sku: string
        quantity: number
        pricing: { rule: string; unitPriceCents: number }
      }[]
      totals: { subtotalCents: number; vatRateBp: number; totalCents: number }
    }>()

    expect(quote.status).toBe(200)
    expect(document.totals.vatRateBp).toBe(1900)

    for (const line of document.lines) {
      expect(line.quantity).toBeGreaterThan(0)
      expect(line.pricing.unitPriceCents).toBeGreaterThan(0)
      expect([
        "historical_override",
        "customer_tier",
        "quantity_break",
        "catalog_base",
      ]).toContain(line.pricing.rule)
    }

    // Every corrected fact reached the quote.
    const final = await readReview(run.viewId)
    expect(final.state).toBe("approved")
    expect(final.decidedAt).not.toBeNull()

    for (const item of final.items) {
      if (item.kind === "product" && item.resolved.sku) {
        expect(document.lines.map((line) => line.sku)).toContain(
          item.resolved.sku
        )
      }

      if (item.kind === "quantity" && item.resolved.quantity) {
        const line = document.lines.find(
          (entry) => entry.position === item.position
        )!
        expect(line.quantity).toBe(item.resolved.quantity)
      }
    }

    // And delivery still works from there, unchanged.
    const delivered = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/deliver`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerCapability}`,
        },
        body: JSON.stringify({ adapter: "corebridge-sandbox" }),
      }
    )

    expect(delivered.status).toBe(200)
  })

  it("prices a product the owner found by searching the whole catalogue", async () => {
    const { run, ownerCapability, review } = await pausedRun()
    const product = review.items.find((item) => item.kind === "product")!

    const search = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/review/catalog?q=NX-`,
      { headers: { authorization: `Bearer ${ownerCapability}` } }
    )

    expect(search.status).toBe(200)
    const { products } = await search.json<{
      products: { sku: string; name: string }[]
    }>()

    const offered = new Set(
      product.alternatives.map((alternative) => alternative.value)
    )
    const chosen = products.find((entry) => !offered.has(entry.sku))!

    expect(chosen).toBeDefined()

    const decisions = straightforwardDecisions(review).map((decision) =>
      decision.itemId === product.id
        ? { itemId: product.id, action: "catalog", sku: chosen.sku }
        : decision
    )

    expect((await decide(run.viewId, ownerCapability, decisions)).status).toBe(
      200
    )
    expect((await settle(run.viewId, ownerCapability, "approve")).status).toBe(
      200
    )

    await waitFor(
      () => readRun(run.viewId),
      (value) =>
        value.workflowState === "estimate_built" ||
        value.workflowState === "failed",
      "a priced run"
    )

    const quote = await (
      await exports.default.fetch(`${base}/api/runs/${run.viewId}/quote`)
    ).json<{ lines: { position: number; sku: string }[] }>()

    expect(
      quote.lines.find((line) => line.position === product.position)!.sku
    ).toBe(chosen.sku)
  })

  it("asks for the customer and the quantity together, and prices both once confirmed", async () => {
    const { run, ownerCapability, review } = await customPausedRun(
      "trigger-invalid-quantity"
    )

    const customer = review.items.find((item) => item.kind === "customer")!
    const quantity = review.items.find((item) => item.kind === "quantity")!

    // One node holds every kind of question this run raised.
    expect(customer).toBeDefined()
    expect(quantity).toBeDefined()
    expect(customer.position).toBe(-1)
    expect(customer.proposal.customerId).toBeNull()
    expect(customer.reasons.join(" ")).toContain("not available")
    expect(quantity.proposal.quantity).toBeNull()

    // An existing customer, chosen by searching; nothing is created.
    const found = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/review/customers?q=`,
      { headers: { authorization: `Bearer ${ownerCapability}` } }
    )

    expect(found.status).toBe(200)
    const { customers } = await found.json<{
      customers: { customerId: string; name: string }[]
    }>()

    expect(customers.length).toBeGreaterThan(0)

    const invented = await decide(run.viewId, ownerCapability, [
      { itemId: customer.id, action: "customer", customerId: "CUST-9999" },
    ])

    expect(invented.status).toBe(400)

    const decisions = review.items.map((item) =>
      item.kind === "customer"
        ? {
            itemId: item.id,
            action: "customer",
            customerId: customers[0].customerId,
          }
        : item.kind === "quantity"
          ? { itemId: item.id, action: "quantity", quantity: 7 }
          : item.proposal.sku
            ? { itemId: item.id, action: "accept" }
            : {
                itemId: item.id,
                action: "alternative",
                sku: item.alternatives[0].value,
              }
    )

    expect((await decide(run.viewId, ownerCapability, decisions)).status).toBe(
      200
    )
    expect((await settle(run.viewId, ownerCapability, "approve")).status).toBe(
      200
    )

    await waitFor(
      () => readRun(run.viewId),
      (value) =>
        value.workflowState === "estimate_built" ||
        value.workflowState === "failed",
      "a priced custom run"
    )

    const quote = await (
      await exports.default.fetch(`${base}/api/runs/${run.viewId}/quote`)
    ).json<{
      customer: { customerId: string; tier: string }
      lines: { position: number; quantity: number }[]
    }>()

    // The corrected identity and quantity are the ones that got priced.
    expect(quote.customer.customerId).toBe(customers[0].customerId)
    expect(
      quote.lines.find((line) => line.position === quantity.position)!.quantity
    ).toBe(7)
  })

  it("asks about an extracted field that failed validation, without editing it", async () => {
    const { run, ownerCapability, review } = await customPausedRun(
      "trigger-invented-sku"
    )

    const field = review.items.find((item) => item.kind === "field")!

    expect(field).toBeDefined()
    expect(field.reasons.join(" ")).toContain("article number")
    expect(field.proposal.label).toContain("exactly as extracted")

    // The only correction available is confirming the extraction as it stands.
    const refused = await decide(run.viewId, ownerCapability, [
      { itemId: field.id, action: "quantity", quantity: 5 },
    ])

    expect(refused.status).toBe(400)
    expect(
      (
        await decide(run.viewId, ownerCapability, [
          { itemId: field.id, action: "accept" },
        ])
      ).status
    ).toBe(200)

    const after = await readReview(run.viewId)
    const confirmed = after.items.find((item) => item.id === field.id)!

    expect(confirmed.state).toBe("resolved")
    expect(confirmed.decision).toBe("confirmed_extraction")
  })

  it("refuses corrections that would invent a product, customer, or quantity", async () => {
    const { run, ownerCapability, review } = await pausedRun()
    const product = review.items.find((item) => item.kind === "product")!
    const quantity = review.items.find((item) => item.kind === "quantity")

    const rejected = [
      { itemId: product.id, action: "catalog", sku: "NOT-A-REAL-SKU" },
      {
        itemId: product.id,
        action: "alternative",
        sku: "NX-FLT-1120",
      },
      { itemId: "not-an-item", action: "accept" },
    ]

    for (const decision of rejected) {
      const response = await decide(run.viewId, ownerCapability, [decision])
      expect(response.status).toBe(400)
    }

    if (quantity) {
      for (const value of [0, -3, 2.5, 1_000_000]) {
        const response = await decide(run.viewId, ownerCapability, [
          { itemId: quantity.id, action: "quantity", quantity: value },
        ])

        expect(response.status).toBe(400)
      }
    }

    const after = await readReview(run.viewId)
    expect(after.resolvedCount).toBe(0)
    expect(after.state).toBe("pending")
  })

  it("treats a mislabelled action on a product line as the catalogue choice it carries", async () => {
    // A product line is decided by the article number a decision carries, not
    // by the action word next to it. Nothing can be invented either way: the
    // SKU still has to be an active catalogue product.
    for (const action of ["customer", "quantity"]) {
      const { run, ownerCapability, review } = await pausedRun()
      const product = review.items.find((item) => item.kind === "product")!
      const sku = product.proposal.sku ?? product.alternatives[0].value

      const invented = await decide(run.viewId, ownerCapability, [
        { itemId: product.id, action, sku: "NOT-A-REAL-SKU" },
      ])

      expect(invented.status).toBe(400)

      const recorded = await decide(run.viewId, ownerCapability, [
        { itemId: product.id, action, sku },
      ])

      expect(recorded.status).toBe(200)

      const after = await readReview(run.viewId)
      const decided = after.items.find((item) => item.id === product.id)!

      expect(decided.state).toBe("resolved")
      expect(decided.decision).toBe("chose_catalog")
      expect(decided.resolved.sku).toBe(sku)
      expect(decided.resolved.quantity).toBeNull()
      expect(decided.resolved.customerId).toBeNull()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Stable outcomes                                                            */
/* -------------------------------------------------------------------------- */

describe("repeated, premature, and rejected decisions", () => {
  it("refuses to approve while decisions are still open", async () => {
    const { run, ownerCapability, review } = await pausedRun()

    const premature = await settle(run.viewId, ownerCapability, "approve")
    expect(premature.status).toBe(409)

    const body = await premature.json<{ error: string; review: Review }>()
    expect(body.error).toContain("still open")
    expect(body.review.state).toBe("pending")

    // The run did not move, and can still be approved properly afterwards.
    expect((await readRun(run.viewId)).workflowState).toBe("awaiting_review")

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))
    expect((await settle(run.viewId, ownerCapability, "approve")).status).toBe(
      200
    )
  })

  it("approves once, however many times it is asked", async () => {
    const { run, ownerCapability, review } = await pausedRun()

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))

    const responses = await Promise.all([
      settle(run.viewId, ownerCapability, "approve"),
      settle(run.viewId, ownerCapability, "approve"),
      settle(run.viewId, ownerCapability, "reject"),
    ])

    const statuses = responses.map((response) => response.status).sort()
    expect(statuses).toEqual([200, 409, 409])

    const settled = await waitFor(
      () => readRun(run.viewId),
      (value) =>
        value.workflowState === "estimate_built" ||
        value.workflowState === "review_rejected" ||
        value.workflowState === "failed",
      "a settled run"
    )

    expect(settled.workflowState).toBe("estimate_built")
    expect((await readReview(run.viewId)).state).toBe("approved")

    // One decision, one progression: the run is priced exactly once.
    const quotes = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM run_quotes WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ total: number }>()

    expect(quotes!.total).toBe(1)

    // And a later decision changes nothing.
    const late = await settle(run.viewId, ownerCapability, "reject")
    expect(late.status).toBe(409)
    expect((await readRun(run.viewId)).workflowState).toBe("estimate_built")
  })

  it("keeps approval retryable when applying its effects fails", async () => {
    const { run, ownerCapability, review } = await pausedRun()
    const runId = await runIdOf(run.viewId)

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))

    await expect(
      settleReview(environmentThatFailsBatches(), runId, "approve")
    ).rejects.toThrow("Forced approval-effects failure")

    expect((await readReview(run.viewId)).state).toBe("pending")
    expect((await readRun(run.viewId)).workflowState).toBe("awaiting_review")

    const retried = await settle(run.viewId, ownerCapability, "approve")
    expect(retried.status).toBe(200)

    const repaired = await readRun(run.viewId)
    expect(["review_approved", "estimate_built"]).toContain(
      repaired.workflowState
    )
    expect(
      repaired.steps.find((step) => step.key === "review-required")!.status
    ).toBe("complete")
    expect((await readReview(run.viewId)).state).toBe("approved")
  })

  it("repairs an older approved row whose effects never completed", async () => {
    const { run, ownerCapability, review } = await pausedRun()
    const runId = await runIdOf(run.viewId)

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))
    await env.DB.prepare(
      `UPDATE run_reviews
          SET state = 'approved', decided_at = ?, summary = ?
        WHERE run_id = ?`
    )
      .bind(
        new Date().toISOString(),
        "Approval committed by an older deployment.",
        runId
      )
      .run()

    const repaired = await settle(run.viewId, ownerCapability, "approve")
    expect(repaired.status).toBe(200)

    const repairedRun = await readRun(run.viewId)
    expect(["review_approved", "estimate_built"]).toContain(
      repairedRun.workflowState
    )
    expect(
      repairedRun.steps.find((step) => step.key === "review-required")!.status
    ).toBe("complete")

    const repeated = await settle(run.viewId, ownerCapability, "approve")
    expect(repeated.status).toBe(409)
  })

  it("stops the run where it stands when the owner rejects it", async () => {
    const { run, ownerCapability, review } = await pausedRun()

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))
    const rejected = await settle(run.viewId, ownerCapability, "reject")

    expect(rejected.status).toBe(200)
    expect((await rejected.json<{ status: string }>()).status).toBe("rejected")

    const settled = await waitFor(
      () => readRun(run.viewId),
      (value) => value.workflowState !== "awaiting_review",
      "a rejected run"
    )

    expect(settled.workflowState).toBe("review_rejected")
    expect(settled.status).toBe("error")

    const node = settled.steps.find((step) => step.key === "review-required")!
    expect(node.status).toBe("error")
    expect(node.summary).toContain("rejected")

    // The graph simply stops: nothing below it ran.
    expect(
      settled.steps.find((step) => step.key === "build-estimate")!.status
    ).toBe("waiting")
    expect(settled.steps.find((step) => step.key === "deliver")!.status).toBe(
      "waiting"
    )

    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM run_quotes WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ total: number }>()

    expect(stored!.total).toBe(0)
  })

  it("removes the review and stops the instance when the run is reset", async () => {
    const { run, ownerCapability } = await pausedRun()
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
      `SELECT (SELECT COUNT(*) FROM run_reviews WHERE run_id = ?1) AS reviews,
              (SELECT COUNT(*) FROM run_review_items WHERE run_id = ?1) AS items,
              (SELECT COUNT(*) FROM runs WHERE id = ?1) AS runs`
    )
      .bind(runId)
      .first<{ reviews: number; items: number; runs: number }>()

    expect(remaining).toEqual({ reviews: 0, items: 0, runs: 0 })
    expect(
      (await exports.default.fetch(`${base}/api/runs/${run.viewId}`)).status
    ).toBe(404)
  })
})

/* -------------------------------------------------------------------------- */
/* Expiry                                                                     */
/* -------------------------------------------------------------------------- */

describe("an expired review", () => {
  it("checks the deadline again inside the transition transaction", async () => {
    const { run, ownerCapability, review } = await pausedRun()
    const runId = await runIdOf(run.viewId)

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))

    const outcome = await settleReview(
      environmentThatExpiresBeforeBatch(runId),
      runId,
      "approve"
    )

    expect(outcome).toMatchObject({ state: "closed" })
    expect((await readReview(run.viewId)).state).toBe("expired")
    expect((await readRun(run.viewId)).workflowState).toBe("review_expired")
  })

  it("refuses a decision made after the window closed", async () => {
    const { run, ownerCapability, review } = await pausedRun()

    await env.DB.prepare(
      `UPDATE run_reviews SET expires_at = ? WHERE run_id = ?`
    )
      .bind(
        new Date(Date.now() - 1_000).toISOString(),
        await runIdOf(run.viewId)
      )
      .run()

    // Both the corrections and the decision are refused, with the same stable
    // outcome rather than an error.
    const recorded = await decide(
      run.viewId,
      ownerCapability,
      straightforwardDecisions(review)
    )

    expect(recorded.status).toBe(409)

    const approved = await settle(run.viewId, ownerCapability, "approve")
    expect(approved.status).toBe(409)
    expect((await approved.json<{ status: string }>()).status).toBe("expired")

    const settled = await readRun(run.viewId)
    expect(settled.workflowState).toBe("review_expired")
    expect(
      settled.steps.find((step) => step.key === "review-required")!.summary
    ).toContain("window closed")
    expect(
      settled.steps.find((step) => step.key === "build-estimate")!.status
    ).toBe("waiting")
    expect((await readReview(run.viewId)).state).toBe("expired")
  })

  it(
    "ends the hibernating workflow when nobody decides in time",
    { timeout: 30_000 },
    async () => {
      const { run } = await pausedRun()

      const settled = await waitFor(
        () => readRun(run.viewId),
        (value) => value.workflowState !== "awaiting_review",
        "an expired run",
        800
      )

      expect(settled.workflowState).toBe("review_expired")
      expect(settled.status).toBe("error")
      expect(
        settled.steps.find((step) => step.key === "review-required")!.status
      ).toBe("error")
      expect(
        settled.steps.find((step) => step.key === "build-estimate")!.status
      ).toBe("waiting")

      const stored = await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM run_quotes WHERE run_id = ?`
      )
        .bind(await runIdOf(run.viewId))
        .first<{ total: number }>()

      expect(stored!.total).toBe(0)
      expect((await readReview(run.viewId)).state).toBe("expired")
    }
  )
})

/* -------------------------------------------------------------------------- */
/* Learning, and its boundary                                                 */
/* -------------------------------------------------------------------------- */

describe("what an approved correction teaches", () => {
  it("replaces an older SKU for the same workspace phrase", async () => {
    const workspace = "workspace-replacement-0123456789"
    const { run, ownerCapability, review } = await pausedRun(workspace)
    const runId = await runIdOf(run.viewId)
    const product = review.items.find((item) => item.kind === "product")!
    const chosen = product.proposal.sku ?? product.alternatives[0].value
    const normalised = normaliseText(product.sourcePhrase)

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))

    const scope = await env.DB.prepare(
      `SELECT r.workspace_hash AS workspace_hash,
              customer.customer_id AS customer_id
         FROM runs r
         JOIN run_customer_resolution customer ON customer.run_id = r.id
        WHERE r.id = ?`
    )
      .bind(runId)
      .first<{ workspace_hash: string; customer_id: string }>()
    const older = await env.DB.prepare(
      `SELECT sku FROM catalog_products
        WHERE status = 'active' AND sku <> ? ORDER BY sku ASC LIMIT 1`
    )
      .bind(chosen)
      .first<{ sku: string }>()

    await env.DB.prepare(
      `INSERT INTO workspace_product_aliases
         (workspace_hash, customer_id, normalised, alias, sku, created_at,
          expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        scope!.workspace_hash,
        scope!.customer_id,
        normalised,
        product.sourcePhrase,
        older!.sku,
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString()
      )
      .run()

    expect((await settle(run.viewId, ownerCapability, "approve")).status).toBe(
      200
    )

    const learned = await env.DB.prepare(
      `SELECT sku FROM workspace_product_aliases
        WHERE workspace_hash = ? AND customer_id = ? AND normalised = ?`
    )
      .bind(scope!.workspace_hash, scope!.customer_id, normalised)
      .all<{ sku: string }>()

    expect(learned.results).toEqual([{ sku: chosen }])
  })

  it("remembers wording inside the owner's workspace and nowhere else", async () => {
    const workspace = "workspace-alpha-0123456789"
    const other = "workspace-beta-9876543210"

    const aliasesBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM catalog_product_aliases`
    ).first<{ total: number }>()

    const first = await pausedRun(workspace)
    const product = first.review.items.find((item) => item.kind === "product")!
    const chosen = product.proposal.sku ?? product.alternatives[0].value

    await decide(
      first.run.viewId,
      first.ownerCapability,
      straightforwardDecisions(first.review)
    )
    expect(
      (await settle(first.run.viewId, first.ownerCapability, "approve")).status
    ).toBe(200)

    await waitFor(
      () => readRun(first.run.viewId),
      (value) => value.workflowState !== "awaiting_review",
      "the first approved run"
    )

    // The seeded catalogue is untouched: learning lives in its own table.
    const aliasesAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM catalog_product_aliases`
    ).first<{ total: number }>()

    expect(aliasesAfter!.total).toBe(aliasesBefore!.total)

    const learned = await env.DB.prepare(
      `SELECT workspace_hash, customer_id, alias, sku
         FROM workspace_product_aliases WHERE sku = ?`
    )
      .bind(chosen)
      .all<{
        workspace_hash: string
        customer_id: string
        alias: string
        sku: string
      }>()

    expect(learned.results.length).toBeGreaterThan(0)
    // The workspace token itself is never stored.
    for (const row of learned.results) {
      expect(row.workspace_hash).not.toBe(workspace)
      expect(row.workspace_hash).toMatch(/^[0-9a-f]{64}$/)
    }

    // A later run in the same browser recognises the wording deterministically.
    const repeat = await createRun("messy-forwarded-request", workspace)
    await waitFor(
      () => readRun(repeat.run.viewId),
      (value) =>
        value.workflowState === "awaiting_review" ||
        value.workflowState === "estimate_built" ||
        value.workflowState === "failed",
      "a second run from the same workspace"
    )

    const repeatMatch = await env.DB.prepare(
      `SELECT m.state AS state, m.method AS method, m.sku AS sku
         FROM run_line_matches m
        WHERE m.run_id = ? AND m.position = ?`
    )
      .bind(await runIdOf(repeat.run.viewId), product.position)
      .first<{ state: string; method: string; sku: string | null }>()

    expect(repeatMatch).toMatchObject({
      state: "accepted",
      method: "known_alias",
      sku: chosen,
    })

    // Another visitor's browser learns nothing from it.
    const stranger = await createRun("messy-forwarded-request", other)
    await waitFor(
      () => readRun(stranger.run.viewId),
      (value) =>
        value.workflowState === "awaiting_review" ||
        value.workflowState === "estimate_built" ||
        value.workflowState === "failed",
      "a run from a different workspace"
    )

    const strangerMatch = await env.DB.prepare(
      `SELECT state, method FROM run_line_matches
        WHERE run_id = ? AND position = ?`
    )
      .bind(await runIdOf(stranger.run.viewId), product.position)
      .first<{ state: string; method: string }>()

    expect(strangerMatch!.method).not.toBe("known_alias")
    expect(strangerMatch!.state).toBe("review_required")
  })
})

/* -------------------------------------------------------------------------- */
/* The outcome, as a value                                                    */
/* -------------------------------------------------------------------------- */

async function retentionOf(runId: string): Promise<string | null> {
  const run = await env.DB.prepare(
    `SELECT source_kind, created_at FROM runs WHERE id = ?`
  )
    .bind(runId)
    .first<{ source_kind: string; created_at: string }>()

  return retentionDeadline(run!.source_kind, run!.created_at)
}

describe("the settled review, read as a value", () => {
  it("has nothing to report while the decision is still the owner's", async () => {
    expect(await loadReviewOutcome(env, "no-such-run")).toBeNull()

    const { run, ownerCapability, review } = await pausedRun()
    const runId = await runIdOf(run.viewId)

    expect(await loadReviewOutcome(env, runId)).toBeNull()

    // Recording corrections settles nothing, so there is still no outcome.
    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))
    expect(await loadReviewOutcome(env, runId)).toBeNull()
  })

  it("carries every corrected value the owning steps need", async () => {
    const { run, ownerCapability, review } = await customPausedRun(
      "trigger-invalid-quantity"
    )
    const runId = await runIdOf(run.viewId)

    const customer = review.items.find((item) => item.kind === "customer")!
    const decisions = review.items.map((item) =>
      item.kind === "customer"
        ? { itemId: item.id, action: "customer", customerId: "CUST-1001" }
        : item.kind === "quantity"
          ? { itemId: item.id, action: "quantity", quantity: 7 }
          : item.kind === "field"
            ? { itemId: item.id, action: "accept" }
            : item.proposal.sku
              ? { itemId: item.id, action: "accept" }
              : {
                  itemId: item.id,
                  action: "alternative",
                  sku: item.alternatives[0].value,
                }
    )

    expect((await decide(run.viewId, ownerCapability, decisions)).status).toBe(
      200
    )
    expect((await settle(run.viewId, ownerCapability, "approve")).status).toBe(
      200
    )

    const final = await readReview(run.viewId)
    const aliasExpiresAt = await retentionOf(runId)
    const outcome = (await loadReviewOutcome(env, runId))!

    expect(outcome.state).toBe("approved")
    expect(outcome.decidedAt).toBe(final.decidedAt)
    expect(outcome.decisions).toHaveLength(final.items.length)

    // Every question the node asked comes back as the value that answers it.
    for (const item of final.items) {
      if (item.kind === "customer") {
        expect(outcome.decisions).toContainEqual({
          kind: "customer",
          customerId: item.resolved.customerId,
        })
      }

      if (item.kind === "quantity") {
        expect(outcome.decisions).toContainEqual({
          kind: "quantity",
          position: item.position,
          quantity: item.resolved.quantity,
        })
      }

      if (item.kind === "field") {
        expect(outcome.decisions).toContainEqual({
          kind: "field",
          position: item.position,
        })
      }

      if (item.kind === "product") {
        expect(outcome.decisions).toContainEqual({
          kind: "product",
          position: item.position,
          sku: item.resolved.sku,
          decision: item.decision,
          sourcePhrase: item.sourcePhrase,
          aliasExpiresAt,
        })
      }
    }

    expect(customer.resolved.customerId).toBeNull()
    expect(
      outcome.decisions.find((entry) => entry.kind === "customer")
    ).toEqual({ kind: "customer", customerId: "CUST-1001" })

    // The same values the approval wrote into the tables other steps own.
    const applied = await env.DB.prepare(
      `SELECT (SELECT customer_id FROM run_customer_resolution
                WHERE run_id = ?1) AS customer_id,
              (SELECT quantity FROM run_rfq_line_items
                WHERE run_id = ?1 AND position = ?2) AS quantity`
    )
      .bind(
        runId,
        final.items.find((item) => item.kind === "quantity")!.position
      )
      .first<{ customer_id: string; quantity: number }>()

    expect(applied).toEqual({ customer_id: "CUST-1001", quantity: 7 })

    for (const decision of outcome.decisions) {
      if (decision.kind !== "product") continue

      const match = await env.DB.prepare(
        `SELECT sku FROM run_line_matches WHERE run_id = ? AND position = ?`
      )
        .bind(runId, decision.position)
        .first<{ sku: string }>()

      expect(match!.sku).toBe(decision.sku)
    }
  })

  it("dates the alias a product correction teaches by the run's retention", async () => {
    const workspace = "workspace-outcome-0123456789"
    const { run, ownerCapability, review } = await pausedRun(workspace)
    const runId = await runIdOf(run.viewId)

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))
    expect((await settle(run.viewId, ownerCapability, "approve")).status).toBe(
      200
    )

    const outcome = (await loadReviewOutcome(env, runId))!
    const product = outcome.decisions.find(
      (decision) => decision.kind === "product"
    )!

    expect(product.kind).toBe("product")
    if (product.kind !== "product") return

    expect(product.aliasExpiresAt).toBe(await retentionOf(runId))
    expect(product.sourcePhrase.length).toBeGreaterThan(0)
    expect([
      "accepted_proposal",
      "chose_alternative",
      "chose_catalog",
    ]).toContain(product.decision)

    const alias = await env.DB.prepare(
      `SELECT expires_at, alias, sku FROM workspace_product_aliases
        WHERE workspace_hash = (SELECT workspace_hash FROM runs WHERE id = ?)
          AND normalised = ?`
    )
      .bind(runId, normaliseText(product.sourcePhrase))
      .first<{ expires_at: string; alias: string; sku: string }>()

    expect(alias).toEqual({
      expires_at: product.aliasExpiresAt,
      alias: product.sourcePhrase,
      sku: product.sku,
    })
  })

  it("applies nothing from a rejected review", async () => {
    const { run, ownerCapability, review } = await pausedRun()
    const runId = await runIdOf(run.viewId)

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))
    expect((await settle(run.viewId, ownerCapability, "reject")).status).toBe(
      200
    )

    const outcome = (await loadReviewOutcome(env, runId))!

    expect(outcome.state).toBe("rejected")
    expect(outcome.decisions).toEqual([])
    expect(outcome.decidedAt).toBe((await readReview(run.viewId)).decidedAt)
  })

  it("applies nothing from a review whose window closed", async () => {
    const { run, ownerCapability, review } = await pausedRun()
    const runId = await runIdOf(run.viewId)

    await decide(run.viewId, ownerCapability, straightforwardDecisions(review))
    await env.DB.prepare(
      `UPDATE run_reviews SET expires_at = ? WHERE run_id = ?`
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), runId)
      .run()

    // The expiry is only an outcome once something has written it down.
    expect(await loadReviewOutcome(env, runId)).toBeNull()
    expect((await settle(run.viewId, ownerCapability, "approve")).status).toBe(
      409
    )

    const outcome = (await loadReviewOutcome(env, runId))!

    expect(outcome.state).toBe("expired")
    expect(outcome.decisions).toEqual([])
    expect(outcome.decidedAt).not.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Leakage                                                                    */
/* -------------------------------------------------------------------------- */

describe("what the review projection never carries", () => {
  it("exposes no capability, workspace token, prompt, or gold answer", async () => {
    const { run, ownerCapability, review } = await pausedRun(
      "workspace-secret-0123456789"
    )

    const serialized = JSON.stringify(review)

    expect(serialized).not.toContain(ownerCapability)
    expect(serialized).not.toContain("workspace-secret")
    expect(serialized.toLowerCase()).not.toContain("expected")
    expect(serialized.toLowerCase()).not.toContain("system prompt")
    expect(serialized).not.toContain("owner_capability")
    expect(serialized).not.toContain("workspaceHash")

    const runView = JSON.stringify(await readRun(run.viewId))
    expect(runView).not.toContain("workspace")
    expect(runView).not.toContain(ownerCapability)
  })
})
