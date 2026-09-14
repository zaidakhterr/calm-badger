import { describe, expect, it } from "vitest"
import type { Catalog, Product } from "../worker/catalog/dataset"
import {
  contactFingerprint,
  EXPECTED_OUTPUT,
  type ExpectedOutput,
  type RunProjection,
} from "../evals/_contracts"
import {
  aggregateScores,
  evaluateExperiment,
  evaluateCatalog,
  evaluateRun,
  evaluateRequest,
  evaluateReviewExpectation,
  isRegression,
  sameReference,
} from "../evals/_evaluators"
import { reviewDecision } from "../evals/_task"

const input = { scenarioId: "small-example", sources: ["Email body"] }
const expected: ExpectedOutput = {
  customerId: "customer",
  contactEmail: "owner@example.test",
  locationId: "depot",
  lines: [
    {
      position: 1,
      sourceReference: "PART-1",
      quantity: 2,
      expectedSku: "PART-1",
      decision: "auto_accept",
      basis: "sku",
      alternatives: ["PART-2"],
    },
  ],
  expectedReviewPositions: [],
}
const part: Product = {
  sku: "PART-1",
  name: "Seal",
  description: "Seal",
  category: "parts",
  manufacturer: "Example",
  unit: "piece",
  basePriceCents: 100,
  status: "active",
  replacementSku: null,
  nearDuplicateOf: null,
  aliases: [{ alias: "seal", kind: "alias", customerId: null }],
  quantityBreaks: [],
}
const catalog: Catalog = {
  seed: 1,
  products: [part, { ...part, sku: "PART-2", nearDuplicateOf: "PART-1" }],
  customers: [
    {
      id: "customer",
      name: "Example",
      domain: "example.test",
      tier: "standard",
      tierDiscountBp: 0,
      contacts: [
        {
          id: "contact",
          name: "Owner",
          email: expected.contactEmail,
          phone: "",
          role: "owner",
        },
      ],
      locations: [
        {
          id: "depot",
          label: "Depot",
          street: "",
          postalCode: "",
          city: "Berlin",
          country: "DE",
        },
      ],
    },
  ],
  orders: [],
  priceOverrides: [],
}
async function projection(): Promise<RunProjection> {
  return {
    viewId: "run",
    workflowState: "delivered",
    wallClockMs: 10,
    sources: ["Email body"],
    structure: {
      validated: {
        customer: { deliveryLocation: "Berlin depot" },
        lineItems: [{ position: 1, reference: "PART-1", quantity: 2 }],
      },
    },
    customer: {
      customerId: "customer",
      contactFingerprint: await contactFingerprint(expected.contactEmail),
      locationId: "depot",
    },
    candidates: { lines: [] },
    matches: {
      lines: [
        {
          position: 1,
          reference: "PART-1",
          state: "matched",
          sku: "PART-1",
          method: "exact-sku",
          alternatives: [{ sku: "PART-2" }],
        },
      ],
    },
    review: null,
    approved: false,
    quote: {
      lines: [
        { position: 1, sku: "PART-1", quantity: 2, pricing: { rule: "base" } },
      ],
      totals: { subtotalCents: 200, vatRateBp: 1900, totalCents: 238 },
    },
    delivery: {
      adapter: "generic",
      externalEstimateId: "estimate",
      simulated: true,
    },
  }
}
function review(): NonNullable<RunProjection["review"]> {
  return {
    state: "pending",
    items: [
      {
        id: "item",
        kind: "product",
        position: 1,
        proposal: { sku: "PART-2", quantity: 2 },
        alternatives: [{ value: "PART-1" }],
      },
    ],
  }
}

describe("experiment evaluators", () => {
  it("checks Cloud source facts against this build's requested lines", () => {
    expect(
      evaluateRequest(expected, [
        { position: 1, reference: "PART-1", quantity: 2 },
      ])
    ).toEqual({ expectedLineCountCorrect: 1, expectedSourceFactsCorrect: 1 })
    expect(
      evaluateRequest(expected, [
        { position: 1, reference: "PART-2", quantity: 2 },
      ]).expectedSourceFactsCorrect
    ).toBe(0)
    expect(evaluateRequest(expected, []).expectedLineCountCorrect).toBe(0)
  })

  it("checks the Cloud review flag and every source position and quantity", () => {
    expect(
      evaluateReviewExpectation(expected, { expectedReview: false })
        .expectedReviewFlagConsistent
    ).toBe(1)
    expect(
      evaluateReviewExpectation(expected, { expectedReview: true })
        .expectedReviewFlagConsistent
    ).toBe(0)
    expect(
      evaluateReviewExpectation(
        { ...expected, expectedReviewPositions: [1] },
        { expectedReview: true }
      ).expectedReviewFlagConsistent
    ).toBe(1)
    expect(
      evaluateRequest(expected, [
        { position: 2, reference: "PART-1", quantity: 2 },
      ]).expectedSourceFactsCorrect
    ).toBe(0)
    expect(
      evaluateRequest(expected, [
        { position: 1, reference: "PART-1", quantity: 3 },
      ]).expectedSourceFactsCorrect
    ).toBe(0)
  })
  it("scores each dimension and exact matches without a retrieval shortlist", async () => {
    const scores = await evaluateRun(
      input,
      expected,
      await projection(),
      catalog
    )
    expect(scores).toEqual({
      lines: 1,
      lineCount: 1,
      lineCountCorrect: 1,
      deliveryLocationCarried: 1,
      sourcesCovered: 1,
      referencesCorrect: 1,
      extractionComplete: 1,
      customerCorrect: 1,
      contactCorrect: 1,
      locationCorrect: 1,
      shortlistHits: 1,
      topThreeHits: 1,
      winnerCorrect: 1,
      selectionCorrect: 1,
      quantityCorrect: 1,
      divergedAfterAsking: 0,
      divergedWithoutAsking: 0,
      reviewOccurred: 0,
      reviewExpected: 0,
      reviewApproved: 0,
      reviewLinesInGold: 0,
      reviewLinesObserved: 0,
      extraReviewLines: 0,
      missedReviewLines: 0,
      reviewPositionsCorrect: 1,
      priced: 1,
      pricedLines: 1,
      subtotalCents: 200,
      vatRateBp: 1900,
      totalCents: 238,
      pricingRules: 1,
      delivered: 1,
      hasExternalId: 1,
      simulated: 1,
      wallClockMs: 10,
      expectedCustomerExists: 1,
      expectedContactExists: 1,
      expectedLocationExists: 1,
      expectedSkusExist: 1,
      expectedSkusActive: 1,
      alternativesExist: 1,
      basisSupported: 1,
      reviewDecisionsConsistent: 1,
      reviewAmbiguitySupported: 1,
      scenarioSourcesPresent: 1,
    })
    expect(isRegression(scores)).toBe(false)
  })
  it("separates shortlist, top three, selection, quantities and asked divergence", async () => {
    const run = await projection()
    run.matches.lines[0].sku = "PART-2"
    run.matches.lines[0].alternatives = [{ sku: "PART-1" }]
    run.candidates.lines = [{ position: 1, candidates: [{ sku: "PART-1" }] }]
    run.quote!.lines[0] = { ...run.quote!.lines[0], sku: "PART-2", quantity: 3 }
    let scores = await evaluateRun(input, expected, run, catalog)
    expect(scores).toMatchObject({
      shortlistHits: 1,
      topThreeHits: 1,
      winnerCorrect: 0,
      selectionCorrect: 0,
      quantityCorrect: 0,
      divergedWithoutAsking: 1,
    })
    expect(isRegression(scores)).toBe(true)
    run.review = review()
    run.approved = true
    scores = await evaluateRun(input, expected, run, catalog)
    expect(scores).toMatchObject({
      divergedWithoutAsking: 0,
      divergedAfterAsking: 1,
      reviewOccurred: 1,
      reviewApproved: 1,
      extraReviewLines: 1,
      reviewPositionsCorrect: 0,
    })
    expect(isRegression(scores)).toBe(false)
    run.quote!.lines = []
    scores = await evaluateRun(input, expected, run, catalog)
    expect(scores.divergedAfterAsking).toBe(0)
    expect(isRegression(scores)).toBe(true)
  })
  it("reports lost extraction, unresolved identity, missing review and failed delivery", async () => {
    const run = await projection()
    run.structure.validated = null
    run.matches.lines = []
    run.sources = []
    run.customer = {
      customerId: null,
      contactFingerprint: null,
      locationId: null,
    }
    run.quote = null
    run.delivery = null
    run.workflowState = "failed"
    const scores = await evaluateRun(
      input,
      { ...expected, expectedReviewPositions: [1] },
      run,
      catalog
    )
    expect(scores).toMatchObject({
      lineCount: 0,
      lineCountCorrect: 0,
      deliveryLocationCarried: 0,
      sourcesCovered: 0,
      referencesCorrect: 0,
      extractionComplete: 0,
      customerCorrect: 0,
      contactCorrect: 0,
      locationCorrect: 0,
      shortlistHits: 0,
      topThreeHits: 0,
      winnerCorrect: 0,
      selectionCorrect: 0,
      quantityCorrect: 0,
      reviewExpected: 1,
      missedReviewLines: 1,
      reviewLinesInGold: 1,
      reviewPositionsCorrect: 0,
      priced: 0,
      delivered: 0,
      hasExternalId: 0,
      simulated: 0,
    })
    expect(isRegression(scores)).toBe(true)
  })
  it("keeps expected lines for failed tasks and missing evaluators", async () => {
    const scores = await evaluateRun(
      input,
      expected,
      await projection(),
      catalog
    )
    const totals = aggregateScores([
      { expectedLines: 1, scores },
      { expectedLines: 2, scores: null },
    ])
    expect(totals).toEqual({
      lines: 3,
      selectionCorrect: 1,
      divergedAfterAsking: 0,
      divergedWithoutAsking: 0,
    })
    expect(isRegression(totals)).toBe(true)
    expect(
      isRegression({
        lines: 3,
        selectionCorrect: 2,
        divergedAfterAsking: 1,
        divergedWithoutAsking: 0,
      })
    ).toBe(false)
    expect(
      isRegression({
        lines: 3,
        selectionCorrect: 3,
        divergedAfterAsking: 0,
        divergedWithoutAsking: 1,
      })
    ).toBe(true)
  })
  it("aggregates SDK results with nested item input and retains missing or unscored cases", async () => {
    const cases = [{ input, expectedOutput: expected }]
    const result = {
      item: { input },
      output: await projection(),
      evaluations: [
        { name: "selectionCorrect" },
        { name: "divergedWithoutAsking" },
      ],
    }
    expect(
      isRegression(await evaluateExperiment(cases, [result], catalog))
    ).toBe(false)
    expect(isRegression(await evaluateExperiment(cases, [], catalog))).toBe(
      true
    )
    expect(
      isRegression(
        await evaluateExperiment(
          cases,
          [{ ...result, evaluations: [] }],
          catalog
        )
      )
    ).toBe(true)
    expect(
      isRegression(
        await evaluateExperiment(cases, [{ ...result, output: null }], catalog)
      )
    ).toBe(true)
    expect(
      isRegression(
        await evaluateExperiment(
          cases,
          [
            {
              ...result,
              output: { ...result.output, workflowState: "failed" },
            },
          ],
          catalog
        )
      )
    ).toBe(true)
  })
  it("rejects missing and duplicate expected lines", () => {
    expect(EXPECTED_OUTPUT.safeParse({ ...expected, lines: [] }).success).toBe(
      false
    )
    expect(
      EXPECTED_OUTPUT.safeParse({
        ...expected,
        lines: [expected.lines[0], expected.lines[0]],
      }).success
    ).toBe(false)
  })
  it("compares whole source references, preserving identifier boundaries", () => {
    expect(sameReference("PART-1 (seal)", "part-1")).toBe(true)
    expect(sameReference("PART-10", "PART-1")).toBe(false)
  })
  it("checks active answers, alternatives, aliases, legacy replacements, and review ambiguity", () => {
    const answer: ExpectedOutput = {
      ...expected,
      lines: [
        {
          ...expected.lines[0],
          decision: "review",
          basis: "alias",
          sourceReference: "seal",
        },
      ],
      expectedReviewPositions: [1],
    }
    expect(evaluateCatalog(answer, input, catalog)).toMatchObject({
      basisSupported: 1,
      reviewDecisionsConsistent: 1,
      reviewAmbiguitySupported: 1,
    })
    answer.lines[0].basis = "typo_alias"
    expect(evaluateCatalog(answer, input, catalog).basisSupported).toBe(1)
    answer.lines[0].basis = "legacy_alias"
    answer.lines[0].sourceReference = "old seal"
    const legacy: Catalog = {
      ...catalog,
      products: [
        part,
        {
          ...part,
          sku: "PART-2",
          status: "archived",
          replacementSku: "PART-1",
          aliases: [{ alias: "old seal", kind: "legacy", customerId: null }],
        },
      ],
    }
    expect(evaluateCatalog(answer, input, legacy)).toMatchObject({
      basisSupported: 1,
      reviewAmbiguitySupported: 1,
    })
    const empty: Catalog = { ...catalog, products: [], customers: [] }
    expect(evaluateCatalog(answer, input, empty)).toMatchObject({
      expectedCustomerExists: 0,
      expectedContactExists: 0,
      expectedLocationExists: 0,
      expectedSkusExist: 0,
      expectedSkusActive: 0,
      alternativesExist: 0,
      basisSupported: 0,
      reviewAmbiguitySupported: 0,
    })
  })
  it("accepts review proposals and uses only offered alternatives and extracted quantities", async () => {
    const item = review().items[0]
    const run = await projection()
    expect(reviewDecision(item, run.structure)).toEqual({
      itemId: "item",
      action: "accept",
    })
    expect(
      reviewDecision(
        { ...item, proposal: { sku: null, quantity: null } },
        run.structure
      )
    ).toEqual({ itemId: "item", action: "alternative", sku: "PART-1" })
    expect(
      reviewDecision(
        { ...item, kind: "quantity", proposal: { sku: null, quantity: null } },
        run.structure
      )
    ).toEqual({ itemId: "item", action: "quantity", quantity: 2 })
    expect(
      reviewDecision({ ...item, kind: "customer" }, run.structure)
    ).toEqual({ itemId: "item", action: "accept" })
  })
})
