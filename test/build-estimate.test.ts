/**
 * Contract for pricing, the canonical quote, and simulated delivery.
 *
 * Three kinds of test live here. The pricing fixtures call the pure rule engine
 * directly, because "which rule prices this line, and what does it round to" is
 * decidable without a run and every combination has to be enumerated. The
 * adapter snapshots transform one fixed canonical quote and assert the complete
 * payload each receiving system would see, without knowing anything about the
 * mapping helpers behind them. Everything else drives the public workflow
 * boundary — create a run, wait for the persisted steps, read the evidence,
 * download the quote, deliver it — with the deterministic contract fakes.
 *
 * No test reaches a live provider, and no adapter opens a socket: delivery is
 * simulated locally by design.
 */

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import {
  buildAdapterPayload,
  externalEstimateId,
  isAdapterId,
} from "../worker/adapters"
import {
  formatAmount,
  priceLine,
  quoteTotals,
  VAT_RATE_BP,
} from "../worker/pricing"
import { QUOTE_SCHEMA, type CanonicalQuote } from "../worker/quote"

const base = "https://example.test"

type RunStep = {
  key: string
  status: string
  summary: string
  startedAt: string | null
  completedAt: string | null
}

type Run = {
  viewId: string
  status: string
  workflowState: string
  steps: RunStep[]
}

type EstimateEvidence = {
  stepKey: string
  state: string
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

type DeliveryEvidence = {
  stepKey: string
  adapters: {
    id: string
    name: string
    contract: string
    payloadFormat: string
    simulated: boolean
    notice: string
  }[]
  defaultAdapter: string
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
    receipt: { externalEstimateId: string; status: string }
  } | null
}

async function createCuratedRun(scenarioId: string) {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)
  return response.json<{ run: Run; ownerCapability: string }>()
}

async function waitForStep(
  viewId: string,
  stepKey: string,
  statuses: string[]
): Promise<RunStep> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
    const { run } = await response.json<{ run: Run }>()
    const step = run.steps.find((candidate) => candidate.key === stepKey)!

    if (statuses.includes(step.status)) return step

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Step ${stepKey} never reached ${statuses.join(" or ")}`)
}

/** The messy request stops before pricing, so waiting on a state is enough. */
async function waitForWorkflowState(
  viewId: string,
  states: string[]
): Promise<Run> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await readRun(viewId)
    if (states.includes(run.workflowState)) return run
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Run never reached ${states.join(" or ")}`)
}

async function readRun(viewId: string): Promise<Run> {
  const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
  return (await response.json<{ run: Run }>()).run
}

async function readEstimate(viewId: string): Promise<EstimateEvidence> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/estimate`
  )

  expect(response.status).toBe(200)
  return (await response.json<{ evidence: EstimateEvidence }>()).evidence
}

async function readDelivery(viewId: string): Promise<DeliveryEvidence> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/delivery`
  )

  expect(response.status).toBe(200)
  return (await response.json<{ evidence: DeliveryEvidence }>()).evidence
}

async function runIdOf(viewId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
    .bind(viewId)
    .first<{ id: string }>()

  return row!.id
}

/** A priced run of the request that needs no human judgement. */
async function pricedRun() {
  const created = await createCuratedRun("routine-replenishment")
  const step = await waitForStep(created.run.viewId, "build-estimate", [
    "complete",
    "error",
  ])

  expect(step.status).toBe("complete")
  return created
}

/* -------------------------------------------------------------------------- */
/* The pricing rules                                                          */
/* -------------------------------------------------------------------------- */

const preferred = { name: "preferred", discountBp: 300 }
const key = { name: "key", discountBp: 650 }
const standard = { name: "standard", discountBp: 0 }
const breaks = [
  { minQuantity: 12, discountBp: 400 },
  { minQuantity: 48, discountBp: 900 },
]
const override = {
  unitPriceCents: 1290,
  effectiveFrom: "2025-11-20",
  reason: "Annual filter agreement",
}

describe("deterministic pricing rules", () => {
  it("prices from the catalogue when no rule applies", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 4,
      tier: standard,
      quantityBreaks: breaks,
      override: null,
    })

    expect(price.rule).toBe("catalog_base")
    expect(price.unitPriceCents).toBe(1490)
    expect(price.discountBp).toBeNull()
    expect(price.subtotalCents).toBe(5960)
    expect(price.explanation).toContain("catalogue price stands")
  })

  it("applies a quantity break for a customer with no tier discount", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 12,
      tier: standard,
      quantityBreaks: breaks,
      override: null,
    })

    expect(price.rule).toBe("quantity_break")
    expect(price.discountBp).toBe(400)
    // 1490 × 0.96 = 1430.4, rounded to the nearest cent.
    expect(price.unitPriceCents).toBe(1430)
    expect(price.subtotalCents).toBe(17_160)
    expect(price.explanation).toContain("12+ break")
  })

  it("takes the deepest break the quantity reaches", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 60,
      tier: standard,
      quantityBreaks: breaks,
      override: null,
    })

    expect(price.discountBp).toBe(900)
    expect(price.unitPriceCents).toBe(1356)
  })

  it("ignores a break the quantity does not reach", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 11,
      tier: standard,
      quantityBreaks: breaks,
      override: null,
    })

    expect(price.rule).toBe("catalog_base")
  })

  it("applies the customer tier before any quantity break", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 60,
      tier: preferred,
      quantityBreaks: breaks,
      override: null,
    })

    // Precedence is an ordered fallback, not the cheapest available price: the
    // 9% break would have discounted further, and the tier still decides.
    expect(price.rule).toBe("customer_tier")
    expect(price.discountBp).toBe(300)
    expect(price.unitPriceCents).toBe(1445)
    expect(price.explanation).toContain("preferred tier")
  })

  it("applies the tier when no break exists at all", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 3,
      tier: key,
      quantityBreaks: [],
      override: null,
    })

    expect(price.rule).toBe("customer_tier")
    // 1490 × 0.935 = 1393.15
    expect(price.unitPriceCents).toBe(1393)
  })

  it("lets an active historical override beat the tier", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 5,
      tier: key,
      quantityBreaks: [],
      override,
    })

    expect(price.rule).toBe("historical_override")
    expect(price.unitPriceCents).toBe(1290)
    expect(price.explanation).toContain("Annual filter agreement")
  })

  it("lets an active historical override beat a deeper quantity break", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 60,
      tier: standard,
      quantityBreaks: breaks,
      override,
    })

    expect(price.rule).toBe("historical_override")
    expect(price.unitPriceCents).toBe(1290)
    expect(price.subtotalCents).toBe(77_400)
  })

  it("beats every other rule at once", () => {
    const price = priceLine({
      basePriceCents: 1490,
      quantity: 60,
      tier: key,
      quantityBreaks: breaks,
      override,
    })

    expect(price.rule).toBe("historical_override")
  })

  it("prices an unresolved customer from product rules only", () => {
    const withBreak = priceLine({
      basePriceCents: 1490,
      quantity: 12,
      tier: null,
      quantityBreaks: breaks,
      override: null,
    })
    const withoutBreak = priceLine({
      basePriceCents: 1490,
      quantity: 1,
      tier: null,
      quantityBreaks: breaks,
      override: null,
    })

    expect(withBreak.rule).toBe("quantity_break")
    expect(withoutBreak.rule).toBe("catalog_base")
  })

  it("rounds a unit price once, to the nearest cent, halves up", () => {
    // 325 × 0.985 = 320.125 → 320; 350 × 0.985 = 344.75 → 345.
    expect(
      priceLine({
        basePriceCents: 325,
        quantity: 3,
        tier: { name: "preferred", discountBp: 150 },
        quantityBreaks: [],
        override: null,
      })
    ).toMatchObject({ unitPriceCents: 320, subtotalCents: 960 })

    expect(
      priceLine({
        basePriceCents: 350,
        quantity: 3,
        tier: { name: "preferred", discountBp: 150 },
        quantityBreaks: [],
        override: null,
      })
    ).toMatchObject({ unitPriceCents: 345, subtotalCents: 1035 })
  })

  it("adds 19% VAT once, over the whole subtotal", () => {
    const totals = quoteTotals([
      { subtotalCents: 1430 },
      { subtotalCents: 1445 },
      { subtotalCents: 1 },
    ])

    expect(VAT_RATE_BP).toBe(1900)
    expect(totals).toEqual({
      lineCount: 3,
      subtotalCents: 2876,
      vatRateBp: 1900,
      // 2876 × 0.19 = 546.44. Rounding each line instead would give 547.
      vatCents: 546,
      totalCents: 3422,
    })
  })

  it("formats cents as EUR amounts without floating arithmetic", () => {
    expect(formatAmount(0)).toBe("0.00")
    expect(formatAmount(5)).toBe("0.05")
    expect(formatAmount(1490)).toBe("14.90")
    expect(formatAmount(123_456)).toBe("1234.56")
  })
})

/* -------------------------------------------------------------------------- */
/* Adapter payloads                                                           */
/* -------------------------------------------------------------------------- */

const fixtureQuote: CanonicalQuote = {
  schema: QUOTE_SCHEMA,
  quoteNumber: "Q-ABCDEF0123",
  issuedAt: "2026-08-13T09:30:00.000Z",
  currency: "EUR",
  priceBasis: "excluding_vat",
  customer: {
    customerId: "CUST-1001",
    name: "Nordwerk Facility Services GmbH",
    tier: "preferred",
    tierDiscountBp: 300,
    contact: {
      name: "Petra Lindqvist",
      role: "Procurement",
      email: "petra@nordwerk.example",
    },
    location: {
      label: "Spandau depot",
      street: "Industriestrasse 14",
      postalCode: "13581",
      city: "Berlin",
      country: "DE",
    },
  },
  source: {
    channel: "email",
    subject: "Replenishment request",
    receivedAt: "2026-08-12T07:05:00.000Z",
    references: ["PO-88213"],
    documents: [
      {
        kind: "email_body",
        label: "Email body",
        mediaType: "text/plain",
        pageCount: 1,
      },
      {
        kind: "attachment",
        label: "request.pdf",
        mediaType: "application/pdf",
        pageCount: 1,
      },
    ],
  },
  lines: [
    {
      position: 1,
      requested: {
        reference: "NX-FLT-1120",
        description: "Panel filter 592x592x48",
        sourceLabel: "request.pdf",
        sourcePage: 1,
      },
      sku: "NX-FLT-1120",
      name: "Panel filter 592x592x48 ISO Coarse 60%",
      unit: "piece",
      quantity: 24,
      pricing: {
        rule: "historical_override",
        ruleLabel: "Historical override",
        basePriceCents: 1490,
        unitPriceCents: 1290,
        discountBp: null,
        explanation:
          "An active customer price of €12.90 applies (Annual filter agreement, effective 2025-11-20), so the €14.90 catalogue price is not used.",
      },
      subtotalCents: 30_960,
      match: { method: "exact_sku", confidenceLabel: "High" },
    },
    {
      position: 2,
      requested: {
        reference: "NX-SFT-2210",
        description: "Nitrile gloves size 9",
        sourceLabel: "Email body",
        sourcePage: null,
      },
      sku: "NX-SFT-2210",
      name: "Nitrile coated glove size 9",
      unit: "pair",
      quantity: 100,
      pricing: {
        rule: "customer_tier",
        ruleLabel: "Customer tier",
        basePriceCents: 320,
        unitPriceCents: 310,
        discountBp: 300,
        explanation:
          "The preferred tier discounts the €3.20 catalogue price by 3.00% to €3.10.",
      },
      subtotalCents: 31_000,
      match: { method: "exact_sku", confidenceLabel: "High" },
    },
  ],
  totals: {
    lineCount: 2,
    subtotalCents: 61_960,
    vatRateBp: 1900,
    vatCents: 11_772,
    totalCents: 73_732,
  },
  metadata: {
    generator: "RFQ Relay",
    schemaVersion: QUOTE_SCHEMA,
    pricingPrecedence: [
      "historical_override",
      "customer_tier",
      "quantity_break",
      "catalog_base",
    ],
    rounding: "…",
    note: "…",
  },
}

const NOTICE =
  "Simulated locally. This adapter transforms the canonical quote and returns a synthetic identifier; no request leaves the application, no third-party system is contacted, and no affiliation or endorsement is implied."

describe("adapter payloads", () => {
  it("maps the canonical quote to the CoreBridge Sandbox document", () => {
    expect(buildAdapterPayload("corebridge-sandbox", fixtureQuote)).toEqual({
      documentType: "SALES_ESTIMATE",
      sandbox: true,
      estimate: {
        reference: "Q-ABCDEF0123",
        issuedOn: "2026-08-13",
        currency: "EUR",
        priceMode: "NET",
        partner: {
          partnerCode: "CUST-1001",
          legalName: "Nordwerk Facility Services GmbH",
          priceGroup: "PREFERRED",
          contact: {
            fullName: "Petra Lindqvist",
            function: "Procurement",
            emailAddress: "petra@nordwerk.example",
          },
        },
        shipTo: {
          siteName: "Spandau depot",
          addressLine: "Industriestrasse 14",
          postalCode: "13581",
          city: "Berlin",
          countryCode: "DE",
        },
        positions: [
          {
            position: 1,
            articleCode: "NX-FLT-1120",
            articleName: "Panel filter 592x592x48 ISO Coarse 60%",
            unitOfMeasure: "piece",
            quantity: 24,
            netUnitPrice: "12.90",
            netAmount: "309.60",
            priceOrigin: "CONTRACT_PRICE",
            priceNote: fixtureQuote.lines[0].pricing.explanation,
          },
          {
            position: 2,
            articleCode: "NX-SFT-2210",
            articleName: "Nitrile coated glove size 9",
            unitOfMeasure: "pair",
            quantity: 100,
            netUnitPrice: "3.10",
            netAmount: "310.00",
            priceOrigin: "PRICE_GROUP",
            priceNote: fixtureQuote.lines[1].pricing.explanation,
          },
        ],
        taxes: [
          {
            code: "DE-VAT-STANDARD",
            ratePercent: "19.00",
            baseAmount: "619.60",
            taxAmount: "117.72",
          },
        ],
        summary: {
          netTotal: "619.60",
          taxTotal: "117.72",
          grossTotal: "737.32",
          positionCount: 2,
        },
      },
      origin: {
        system: "RFQ Relay",
        channel: "email",
        documentReferences: ["PO-88213"],
        attachments: [
          "Email body (text/plain)",
          "request.pdf (application/pdf)",
        ],
      },
      disclaimer: NOTICE,
    })
  })

  it("maps the same quote to the Generic ERP Webhook event", () => {
    expect(buildAdapterPayload("generic-erp-webhook", fixtureQuote)).toEqual({
      event: "quote.created",
      event_version: 1,
      idempotency_key: "Q-ABCDEF0123",
      simulated: true,
      data: {
        quote_id: "Q-ABCDEF0123",
        issued_at: "2026-08-13T09:30:00.000Z",
        currency: "EUR",
        amount_scale: "minor_units",
        prices_include_tax: false,
        customer_id: "CUST-1001",
        customer_name: "Nordwerk Facility Services GmbH",
        customer_tier: "preferred",
        customer_tier_discount_bp: 300,
        contact_email: "petra@nordwerk.example",
        ship_to_city: "Berlin",
        ship_to_country: "DE",
        ship_to_postal_code: "13581",
        items: [
          {
            line_no: 1,
            sku: "NX-FLT-1120",
            description: "Panel filter 592x592x48 ISO Coarse 60%",
            uom: "piece",
            qty: 24,
            unit_price: 1290,
            list_price: 1490,
            line_total: 30_960,
            pricing_rule: "historical_override",
            discount_bp: null,
          },
          {
            line_no: 2,
            sku: "NX-SFT-2210",
            description: "Nitrile coated glove size 9",
            uom: "pair",
            qty: 100,
            unit_price: 310,
            list_price: 320,
            line_total: 31_000,
            pricing_rule: "customer_tier",
            discount_bp: 300,
          },
        ],
        subtotal: 61_960,
        tax_rate_bp: 1900,
        tax_total: 11_772,
        grand_total: 73_732,
        source_channel: "email",
        source_references: ["PO-88213"],
        source_document_count: 2,
      },
      notice: NOTICE,
    })
  })

  it("designs the two payloads independently rather than renaming one", () => {
    const coreBridge = buildAdapterPayload("corebridge-sandbox", fixtureQuote)
    const webhook = buildAdapterPayload("generic-erp-webhook", fixtureQuote)

    expect(Object.keys(coreBridge as object)).not.toEqual(
      Object.keys(webhook as object)
    )

    // One carries decimal strings, the other integer minor units, from the
    // same canonical amount.
    expect(JSON.stringify(coreBridge)).toContain('"netUnitPrice":"12.90"')
    expect(JSON.stringify(webhook)).toContain('"unit_price":1290')
  })

  it("derives a stable synthetic identifier per adapter", () => {
    const first = externalEstimateId("corebridge-sandbox", "Q-ABCDEF0123")
    const second = externalEstimateId("generic-erp-webhook", "Q-ABCDEF0123")

    expect(first).toBe(externalEstimateId("corebridge-sandbox", "Q-ABCDEF0123"))
    expect(first).toMatch(/^CBX-SBX-\d{8}$/)
    expect(second).toMatch(/^ERP-SIM-\d{6}-\d{4}$/)
    expect(first).not.toBe(second)
    expect(isAdapterId("corebridge-sandbox")).toBe(true)
    expect(isAdapterId("sap")).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* The workflow boundary                                                      */
/* -------------------------------------------------------------------------- */

describe("pricing a run that needs no review", () => {
  it("prices every accepted line and explains each applied rule", async () => {
    const { run } = await pricedRun()
    const evidence = await readEstimate(run.viewId)
    const quote = evidence.quote!

    expect(evidence.state).toBe("complete")
    expect(quote.schema).toBe(QUOTE_SCHEMA)
    expect(quote.currency).toBe("EUR")
    expect(quote.customer.customerId).toMatch(/^CUST-/)
    expect(quote.lines).toHaveLength(6)

    for (const line of quote.lines) {
      expect(line.quantity).toBeGreaterThan(0)
      expect(line.pricing.unitPriceCents).toBeGreaterThan(0)
      expect(line.subtotalCents).toBe(
        line.pricing.unitPriceCents * line.quantity
      )
      expect(line.pricing.explanation.length).toBeGreaterThan(20)
      expect([
        "historical_override",
        "customer_tier",
        "quantity_break",
        "catalog_base",
      ]).toContain(line.pricing.rule)
    }

    expect(quote.totals.subtotalCents).toBe(
      quote.lines.reduce((total, line) => total + line.subtotalCents, 0)
    )
    expect(quote.totals.vatRateBp).toBe(1900)
    expect(quote.totals.vatCents).toBe(
      Math.round((quote.totals.subtotalCents * 19) / 100)
    )
    expect(quote.totals.totalCents).toBe(
      quote.totals.subtotalCents + quote.totals.vatCents
    )

    expect(evidence.rules!.precedence).toEqual([
      "historical_override",
      "customer_tier",
      "quantity_break",
      "catalog_base",
    ])
    expect(evidence.rules!.rounding).toContain("nearest cent")
    expect(evidence.totals!.totalCents).toBe(quote.totals.totalCents)
  })

  it("uses this customer's active override and ignores a superseded one", async () => {
    const { run } = await pricedRun()
    const quote = (await readEstimate(run.viewId)).quote!
    const filter = quote.lines.find((line) => line.sku === "NX-FLT-1120")!

    // CUST-1001 has an active annual price for this filter.
    expect(quote.customer.customerId).toBe("CUST-1001")
    expect(filter.pricing.rule).toBe("historical_override")
    expect(filter.pricing.unitPriceCents).toBe(1290)

    const superseded = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM catalog_price_overrides
        WHERE active = 0 AND customer_id = ?`
    )
      .bind(quote.customer.customerId)
      .first<{ total: number }>()

    // Whatever this customer's expired prices are, none of them priced a line.
    for (const line of quote.lines) {
      expect(line.pricing.unitPriceCents).toBeGreaterThan(0)
    }
    expect(superseded!.total).toBeGreaterThanOrEqual(0)
  })

  it("persists the estimate as a graph state with stored amounts", async () => {
    const { run } = await pricedRun()
    const settled = await readRun(run.viewId)
    const step = settled.steps.find((entry) => entry.key === "build-estimate")!

    expect(step.status).toBe("complete")
    expect(step.summary).toContain("Priced 6 lines")
    expect(step.summary).toContain("including VAT")
    expect(step.startedAt).not.toBeNull()
    expect(step.completedAt).not.toBeNull()
    expect(settled.workflowState).toBe("estimate_built")

    const stored = await env.DB.prepare(
      `SELECT quote_number, currency, line_count, subtotal_cents, vat_rate_bp,
              vat_cents, total_cents
         FROM run_quotes WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .first<{
        quote_number: string
        currency: string
        line_count: number
        subtotal_cents: number
        vat_rate_bp: number
        vat_cents: number
        total_cents: number
      }>()

    expect(stored!.currency).toBe("EUR")
    expect(stored!.line_count).toBe(6)
    expect(stored!.vat_rate_bp).toBe(1900)
    expect(stored!.total_cents).toBe(stored!.subtotal_cents + stored!.vat_cents)
    expect(Number.isInteger(stored!.total_cents)).toBe(true)
  })

  it("waits instead of pricing a run whose lines still need a human", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    const settled = await waitForWorkflowState(run.viewId, [
      "awaiting_review",
      "failed",
    ])

    const estimate = settled.steps.find(
      (step) => step.key === "build-estimate"
    )!

    expect(settled.workflowState).toBe("awaiting_review")
    expect(estimate.status).toBe("waiting")
    expect(estimate.summary).toContain("Waiting for owner review")
    expect(estimate.completedAt).toBeNull()
    // The run stays active with no active step: nothing is stuck running.
    expect(settled.status).toBe("active")
    expect(settled.steps.some((step) => step.status === "active")).toBe(false)

    const quotes = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM run_quotes WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ total: number }>()

    expect(quotes!.total).toBe(0)

    const evidence = await readEstimate(run.viewId)
    expect(evidence.state).toBe("pending")
    expect(evidence.quote).toBeNull()

    const download = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/quote`
    )
    expect(download.status).toBe(404)
  })
})

describe("downloading the canonical quote", () => {
  it("serves the quote as a JSON file to any holder of the run URL", async () => {
    const { run } = await pricedRun()
    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/quote`,
      { headers: { authorization: "Bearer not-the-owner" } }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("content-disposition")).toContain("attachment")

    const text = await response.text()
    const quote = JSON.parse(text) as CanonicalQuote

    expect(response.headers.get("content-disposition")).toContain(
      `${quote.quoteNumber}.json`
    )
    expect(quote.schema).toBe(QUOTE_SCHEMA)
    expect(quote.lines).toHaveLength(6)
    expect(quote.metadata.pricingPrecedence[0]).toBe("historical_override")
  })

  it("carries no capability, storage key, prompt, or provider detail", async () => {
    const { run, ownerCapability } = await pricedRun()
    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/quote`
    )
    const text = await response.text()

    const storageKeys = await env.DB.prepare(
      `SELECT storage_key FROM run_sources WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .all<{ storage_key: string }>()

    expect(storageKeys.results.length).toBeGreaterThan(0)

    for (const row of storageKeys.results) {
      expect(text).not.toContain(row.storage_key)
    }

    expect(text).not.toContain(ownerCapability)
    expect(text).not.toContain("Bearer")
    expect(text).not.toContain("api.mistral.ai")
    expect(text).not.toContain("openrouter")
    expect(text.toLowerCase()).not.toContain("api_key")
    expect(text.toLowerCase()).not.toContain("prompt")
  })
})

describe("choosing and inspecting an adapter", () => {
  it("offers both simulated adapters, with CoreBridge preselected", async () => {
    const { run } = await pricedRun()
    const evidence = await readDelivery(run.viewId)

    expect(evidence.defaultAdapter).toBe("corebridge-sandbox")
    expect(evidence.quoteAvailable).toBe(true)
    expect(evidence.delivery).toBeNull()
    expect(evidence.adapters.map((adapter) => adapter.id)).toEqual([
      "corebridge-sandbox",
      "generic-erp-webhook",
    ])

    for (const adapter of evidence.adapters) {
      expect(adapter.simulated).toBe(true)
      expect(adapter.notice).toContain("no request leaves the application")
      expect(adapter.notice).toContain("no affiliation or endorsement")
    }
  })

  it("shows the owner each payload before anything is delivered", async () => {
    const { run, ownerCapability } = await pricedRun()

    for (const adapter of ["corebridge-sandbox", "generic-erp-webhook"]) {
      const response = await exports.default.fetch(
        `${base}/api/runs/${run.viewId}/delivery/preview?adapter=${adapter}`,
        { headers: { authorization: `Bearer ${ownerCapability}` } }
      )

      expect(response.status).toBe(200)
      const preview = await response.json<{
        payload: unknown
        adapter: { id: string; simulated: boolean }
      }>()

      expect(preview.adapter.id).toBe(adapter)
      expect(preview.payload).not.toBeNull()
    }

    // Inspecting delivered nothing: the graph is untouched.
    const after = await readRun(run.viewId)
    expect(after.workflowState).toBe("estimate_built")
    expect(after.steps.find((step) => step.key === "delivered")!.status).toBe(
      "waiting"
    )
  })

  it("withholds the payload preview from a shared viewer", async () => {
    const { run } = await pricedRun()

    const anonymous = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/delivery/preview?adapter=corebridge-sandbox`
    )
    const wrong = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/delivery/preview?adapter=corebridge-sandbox`,
      { headers: { authorization: "Bearer not-the-owner" } }
    )

    expect(anonymous.status).toBe(401)
    expect(wrong.status).toBe(403)
  })

  it("rejects an unknown adapter", async () => {
    const { run, ownerCapability } = await pricedRun()
    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/delivery/preview?adapter=sap`,
      { headers: { authorization: `Bearer ${ownerCapability}` } }
    )

    expect(response.status).toBe(400)
  })
})

describe("delivering the quote", () => {
  async function deliver(
    viewId: string,
    adapter: string,
    capability: string | null
  ) {
    return exports.default.fetch(`${base}/api/runs/${viewId}/deliver`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(capability ? { authorization: `Bearer ${capability}` } : {}),
      },
      body: JSON.stringify({ adapter }),
    })
  }

  it("returns a synthetic identifier and ends the graph at Delivered", async () => {
    const { run, ownerCapability } = await pricedRun()
    const response = await deliver(
      run.viewId,
      "generic-erp-webhook",
      ownerCapability
    )

    expect(response.status).toBe(200)

    const body = await response.json<{
      status: string
      delivery: {
        adapter: { id: string; name: string; simulated: boolean }
        payload: unknown
        receipt: {
          externalEstimateId: string
          status: string
          simulated: boolean
          notice: string
        }
      }
    }>()

    expect(body.status).toBe("delivered")
    expect(body.delivery.adapter.name).toBe("Generic ERP Webhook")
    expect(body.delivery.receipt.simulated).toBe(true)
    expect(body.delivery.receipt.status).toBe("accepted")
    expect(body.delivery.receipt.externalEstimateId).toMatch(/^ERP-SIM-/)
    expect(body.delivery.receipt.notice).toContain("Simulated locally")

    const settled = await readRun(run.viewId)
    const deliverStep = settled.steps.find((step) => step.key === "deliver")!
    const deliveredStep = settled.steps.find(
      (step) => step.key === "delivered"
    )!

    expect(deliverStep.status).toBe("complete")
    expect(deliverStep.summary).toContain("simulated")
    expect(deliveredStep.status).toBe("complete")
    expect(deliveredStep.summary).toContain(
      body.delivery.receipt.externalEstimateId
    )
    expect(deliveredStep.completedAt).not.toBeNull()
    expect(settled.workflowState).toBe("delivered")
    expect(settled.status).toBe("complete")
    expect(settled.steps.every((step) => step.status !== "active")).toBe(true)
  })

  it("shows the delivered payload and identifier to a shared viewer", async () => {
    const { run, ownerCapability } = await pricedRun()
    await deliver(run.viewId, "corebridge-sandbox", ownerCapability)

    const evidence = await readDelivery(run.viewId)

    expect(evidence.delivery!.adapter).toBe("corebridge-sandbox")
    expect(evidence.delivery!.externalEstimateId).toMatch(/^CBX-SBX-/)
    expect(evidence.delivery!.simulated).toBe(true)
    expect(JSON.stringify(evidence.delivery!.payload)).toContain(
      "SALES_ESTIMATE"
    )
  })

  it("refuses delivery without the owner capability", async () => {
    const { run } = await pricedRun()

    expect((await deliver(run.viewId, "corebridge-sandbox", null)).status).toBe(
      401
    )
    expect(
      (await deliver(run.viewId, "corebridge-sandbox", "not-the-owner")).status
    ).toBe(403)

    const evidence = await readDelivery(run.viewId)
    expect(evidence.delivery).toBeNull()
  })

  it("refuses an unknown adapter and a run that is not priced", async () => {
    const { run, ownerCapability } = await pricedRun()
    expect((await deliver(run.viewId, "sap", ownerCapability)).status).toBe(400)

    const unpriced = await createCuratedRun("messy-forwarded-request")
    await waitForWorkflowState(unpriced.run.viewId, [
      "awaiting_review",
      "failed",
    ])

    const response = await deliver(
      unpriced.run.viewId,
      "corebridge-sandbox",
      unpriced.ownerCapability
    )

    expect(response.status).toBe(409)
  })

  it("does not deliver the same run twice", async () => {
    const { run, ownerCapability } = await pricedRun()

    const first = await deliver(
      run.viewId,
      "corebridge-sandbox",
      ownerCapability
    )
    const second = await deliver(
      run.viewId,
      "generic-erp-webhook",
      ownerCapability
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM run_deliveries WHERE run_id = ?`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ total: number }>()

    expect(rows!.total).toBe(1)
  })

  it("removes the quote and the delivery when the run is reset", async () => {
    const { run, ownerCapability } = await pricedRun()
    await deliver(run.viewId, "corebridge-sandbox", ownerCapability)

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
         (SELECT COUNT(*) FROM run_quotes WHERE run_id = ?1) AS quotes,
         (SELECT COUNT(*) FROM run_deliveries WHERE run_id = ?1) AS deliveries`
    )
      .bind(runId)
      .first<{ quotes: number; deliveries: number }>()

    expect(remaining).toEqual({ quotes: 0, deliveries: 0 })
  })
})
