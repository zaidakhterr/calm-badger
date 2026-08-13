/**
 * Gold expectations for the three curated scenarios.
 *
 * These are the answers a correct run should reach: which customer the request
 * belongs to, what a faithful extraction contains, and which catalogue product
 * each requested line means. They are evaluation material, deliberately kept
 * out of `worker/` so that no runtime path can read an expectation instead of
 * producing a result. Ticket 12 scores real runs against them; until then the
 * dataset test asserts that every reference here exists in the generated
 * catalogue, which is what makes the curated decisions decidable at all.
 */

import type { ScenarioId } from "../../worker/scenarios"

/**
 * How a line is expected to be decided:
 * - `auto_accept`: deterministic evidence (article number or a known alias)
 *   settles it before any model judgement.
 * - `model_match`: retrieval and reranking should select it with enough
 *   confidence to continue without a human.
 * - `review`: the catalogue genuinely cannot settle it, so the run should stop
 *   and ask.
 */
export type GoldDecision = "auto_accept" | "model_match" | "review"

export type GoldMatch = {
  position: number
  /** The phrase the request uses, as extraction should capture it. */
  sourceReference: string
  quantity: number
  expectedSku: string
  decision: GoldDecision
  /** The evidence that should carry the decision. */
  basis: "sku" | "alias" | "typo_alias" | "legacy_alias" | "description"
  /** Catalogue products a correct run must consider and reject. */
  alternatives: string[]
  reason: string
}

export type GoldScenario = {
  scenarioId: ScenarioId
  customer: {
    customerId: string
    contactEmail: string
    locationId: string
    evidence: string
  }
  extraction: {
    lineItemCount: number
    /** Facts the structured RFQ must carry through from the sources. */
    deliveryHint: string
    sourcesUsed: ("email" | "pdf" | "image")[]
  }
  matches: GoldMatch[]
  expectedReviewPositions: number[]
}

export const GOLD_SCENARIOS: GoldScenario[] = [
  {
    scenarioId: "routine-replenishment",
    customer: {
      customerId: "CUST-1001",
      contactEmail: "lena.vogt@northline-services.example",
      locationId: "CUST-1001-L1",
      evidence:
        "Sender address matches a known contact; the email names the Spandau service depot.",
    },
    extraction: {
      lineItemCount: 6,
      deliveryHint: "Spandau service depot, Berlin",
      sourcesUsed: ["email", "pdf", "image"],
    },
    matches: [
      {
        position: 1,
        sourceReference: "NX-FLT-1120",
        quantity: 24,
        expectedSku: "NX-FLT-1120",
        decision: "auto_accept",
        basis: "sku",
        alternatives: ["NX-FLT-1121"],
        reason: "Current article number, confirmed by the shelf-label photo.",
      },
      {
        position: 2,
        sourceReference: "NX-LUB-3040",
        quantity: 12,
        expectedSku: "NX-LUB-3040",
        decision: "auto_accept",
        basis: "sku",
        alternatives: ["NX-LUB-3041"],
        reason: "Current article number; the 1 kg tin is the near duplicate.",
      },
      {
        position: 3,
        sourceReference: "NX-SFT-2210",
        quantity: 24,
        expectedSku: "NX-SFT-2210",
        decision: "auto_accept",
        basis: "sku",
        alternatives: ["NX-SFT-2211"],
        reason: "Current article number; size 10 is the near duplicate.",
      },
      {
        position: 4,
        sourceReference: "NX-CLN-5015",
        quantity: 4,
        expectedSku: "NX-CLN-5015",
        decision: "auto_accept",
        basis: "sku",
        alternatives: [],
        reason: "Current article number.",
      },
      {
        position: 5,
        sourceReference: "NX-FAS-4402",
        quantity: 5,
        expectedSku: "NX-FAS-4402",
        decision: "auto_accept",
        basis: "sku",
        alternatives: ["NX-FAS-4403"],
        reason:
          "Current article number; the M10 x 70 box is the near duplicate.",
      },
      {
        position: 6,
        sourceReference: "NX-ELC-7305",
        quantity: 30,
        expectedSku: "NX-ELC-7305",
        decision: "auto_accept",
        basis: "sku",
        alternatives: ["NX-ELC-7306"],
        reason:
          "Current article number; the 1500 mm tube is the near duplicate.",
      },
    ],
    expectedReviewPositions: [],
  },
  {
    scenarioId: "messy-forwarded-request",
    customer: {
      customerId: "CUST-1002",
      contactEmail: "marta.klein@bergmann-facility.example",
      locationId: "CUST-1002-L1",
      evidence:
        "Forwarding sender and the original author share a known customer domain; the email names the south site.",
    },
    extraction: {
      lineItemCount: 6,
      deliveryHint: "South site, Cologne",
      sourcesUsed: ["email", "pdf", "image"],
    },
    matches: [
      {
        position: 1,
        sourceReference: "pleeted panel filter 592x592",
        quantity: 16,
        expectedSku: "NX-FLT-1120",
        decision: "model_match",
        basis: "typo_alias",
        alternatives: ["NX-FLT-1121"],
        reason:
          "Misspelling of a stocked panel filter; the half-size filter shares the leading dimension.",
      },
      {
        position: 2,
        sourceReference: "EP2 grease cartridge 400g",
        quantity: 12,
        expectedSku: "NX-LUB-3040",
        decision: "auto_accept",
        basis: "alias",
        alternatives: ["NX-LUB-3041"],
        reason: "Exact known alias.",
      },
      {
        position: 3,
        sourceReference: "SPA1250 v-belt",
        quantity: 4,
        expectedSku: "NX-DRV-6120",
        decision: "model_match",
        basis: "alias",
        alternatives: ["NX-DRV-6121"],
        reason:
          "Profile and length identify the belt; the SPA 1320 belt is the near duplicate.",
      },
      {
        position: 4,
        sourceReference: "old item nr 45-221-B",
        quantity: 2,
        expectedSku: "NX-PMP-8140",
        decision: "review",
        basis: "legacy_alias",
        alternatives: ["NX-PMP-8130"],
        reason:
          "The legacy number belongs to an archived seal kit; substituting its successor needs confirmation.",
      },
      {
        position: 5,
        sourceReference: "safety gloves size 9 nitrile",
        quantity: 60,
        expectedSku: "NX-SFT-2210",
        decision: "model_match",
        basis: "alias",
        alternatives: ["NX-SFT-2211"],
        reason: "Size is stated, so the size 10 glove can be ruled out.",
      },
      {
        position: 6,
        sourceReference: "flat gasket DN50 PTFE",
        quantity: 20,
        expectedSku: "NX-SEA-9120",
        decision: "review",
        basis: "description",
        alternatives: ["NX-SEA-9121"],
        reason:
          "Thickness is missing and both stocked thicknesses fit the description.",
      },
    ],
    expectedReviewPositions: [4, 6],
  },
  {
    scenarioId: "ambiguous-replacement-parts",
    customer: {
      customerId: "CUST-1003",
      contactEmail: "jonas.richter@westmark-care.example",
      locationId: "CUST-1003-L1",
      evidence:
        "Sender address matches a known contact; the only location is the Amsterdam workshop.",
    },
    extraction: {
      lineItemCount: 6,
      deliveryHint: "Amsterdam workshop",
      sourcesUsed: ["email", "pdf", "image"],
    },
    matches: [
      {
        position: 1,
        sourceReference: "6205-2RS bearing",
        quantity: 10,
        expectedSku: "NX-BRG-3311",
        decision: "review",
        basis: "legacy_alias",
        alternatives: ["NX-BRG-3310"],
        reason:
          "The designation names an archived bearing; its low-friction successor needs confirmation.",
      },
      {
        position: 2,
        sourceReference: "flange gasket DN50, 3 mm",
        quantity: 12,
        expectedSku: "NX-SEA-9121",
        decision: "model_match",
        basis: "description",
        alternatives: ["NX-SEA-9120"],
        reason: "The measured thickness separates it from the 2 mm gasket.",
      },
      {
        position: 3,
        sourceReference: "hydraulic hose 1/2 inch, approx 2 m, DKOL",
        quantity: 2,
        expectedSku: "NX-HOS-2406",
        decision: "model_match",
        basis: "description",
        alternatives: ["NX-HOS-2405"],
        reason:
          "About two metres is the 2000 mm assembly, not the 1500 mm one.",
      },
      {
        position: 4,
        sourceReference: "LED tube, label ends 7305, 1200 mm",
        quantity: 8,
        expectedSku: "NX-ELC-7305",
        decision: "model_match",
        basis: "description",
        alternatives: ["NX-ELC-7306"],
        reason:
          "The photographed label fragment and the stated length agree on the 1200 mm tube.",
      },
      {
        position: 5,
        sourceReference: "ball valve 1 1/4 inch brass",
        quantity: 6,
        expectedSku: "NX-VLV-5521",
        decision: "review",
        basis: "description",
        alternatives: ["NX-VLV-5520"],
        reason:
          "The imperial size means DN32, while the imperial alias in the catalogue points at the DN25 valve.",
      },
      {
        position: 6,
        sourceReference: "hex bolts M10, 70 long, zinc, one box",
        quantity: 1,
        expectedSku: "NX-FAS-4403",
        decision: "model_match",
        basis: "description",
        alternatives: ["NX-FAS-4402"],
        reason:
          "The stated length picks the M10 x 70 box over the M10 x 60 box.",
      },
    ],
    expectedReviewPositions: [1, 5],
  },
]

export function goldScenario(scenarioId: ScenarioId): GoldScenario {
  const gold = GOLD_SCENARIOS.find(
    (candidate) => candidate.scenarioId === scenarioId
  )
  if (!gold) throw new Error(`No gold fixture for scenario: ${scenarioId}`)
  return gold
}
