import { env, exports } from "cloudflare:workers"
import { beforeAll, describe, expect, it } from "vitest"

import { REFERENCE_EVALUATION } from "../worker/evaluation-report"
import {
  evaluateReferenceWorkflows,
  summarize,
  type EvaluationReport,
} from "./fixtures/reference-evaluation"

/**
 * The measured reference workflows.
 *
 * Three complete runs are driven across the public API and scored against the
 * gold fixtures. The same file runs twice: under the ordinary configuration
 * every seam is a contract fake, so the result is deterministic and free; under
 * `vitest.live.config.ts` (`pnpm eval:live`) the identical code scores live OCR
 * and language-model providers.
 *
 * The report is printed as one line so that `scripts/run-evaluation.mjs` can
 * read it back, render it for a maintainer, and refresh the committed summary
 * that System details serves.
 */

const base = "https://example.test"

/** A distinct address per scenario, so the public run limit is not the thing under test. */
let address = 10

const fetcher = (path: string, init?: RequestInit) => {
  if (init?.method === "POST" && path === "/api/runs") {
    address += 1
    return exports.default.fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        "cf-connecting-ip": `203.0.113.${address}`,
      },
    })
  }

  return exports.default.fetch(`${base}${path}`, init)
}

let report: EvaluationReport

beforeAll(async () => {
  // Live providers are slower than a fake by orders of magnitude, so patience
  // follows the configuration rather than being fixed for both.
  const fakes = [
    env.OCR_PROVIDER,
    env.EXTRACTION_PROVIDER,
    env.RERANK_PROVIDER,
  ].every((provider: string) => provider === "contract-fake")

  report = await evaluateReferenceWorkflows(fetcher, {
    pollAttempts: fakes ? 600 : 1_200,
    pollIntervalMs: fakes ? 25 : 250,
  })

  console.log(`RFQ_EVAL_REPORT ${JSON.stringify(report)}`)
}, 600_000)

describe("the three reference workflows", () => {
  it("reports identity, extraction, retrieval, selection, and review per scenario", () => {
    expect(report.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "routine-replenishment",
      "messy-forwarded-request",
      "ambiguous-replacement-parts",
    ])

    for (const scenario of report.scenarios) {
      // Customer resolution.
      expect(scenario.resolution.customerId).not.toBeNull()
      expect(typeof scenario.resolution.customerCorrect).toBe("boolean")
      expect(typeof scenario.resolution.locationCorrect).toBe("boolean")

      // The fields the structured RFQ had to carry through.
      expect(scenario.extraction.lineCount).toBeGreaterThan(0)
      expect(scenario.extraction.sources.length).toBeGreaterThan(0)
      expect(typeof scenario.extraction.deliveryLocationCarried).toBe("boolean")

      // Top-three candidate recall, and the final product selection.
      expect(scenario.retrieval.lines).toBe(scenario.selection.lines)
      expect(scenario.reranking.topThreeHits).toBeLessThanOrEqual(
        scenario.selection.lines
      )
      // Every gold line has to arrive in the priced estimate as a real
      // catalogue SKU. `finalSku` is the one the quote charges for, so assert
      // that directly rather than letting an earlier candidate stand in for it.
      for (const line of scenario.lines) {
        expect(typeof line.finalSku).toBe("string")
        expect(line.finalSku).not.toBe("")
        expect(line.quantity).toBeGreaterThan(0)
      }

      // Whether review should occur, and whether it did.
      expect(typeof scenario.review.occurred).toBe("boolean")
      expect(typeof scenario.review.occursInGold).toBe("boolean")
    }
  })

  it("separates extraction, resolution, retrieval, reranking, review, pricing, and export", () => {
    for (const scenario of report.scenarios) {
      expect(scenario.workflowState).toBe("estimate_built")
      expect(scenario.pricing.priced).toBe(true)
      expect(scenario.pricing.vatRateBp).toBe(1900)
      expect(scenario.pricing.subtotalCents).toBeGreaterThan(0)
      expect(scenario.pricing.rules.length).toBeGreaterThan(0)
      expect(scenario.export.delivered).toBe(true)
      expect(scenario.export.hasExternalId).toBe(true)
      expect(scenario.export.simulated).toBe(true)

      // A run that stopped was released by the owner capability, which is what
      // makes the priced and exported outcomes below post-review facts.
      if (scenario.review.occurred) {
        expect(scenario.review.approved).toBe(true)
      }
    }
  })

  it("never accepts a line the fixtures call uncertain without asking", () => {
    for (const scenario of report.scenarios) {
      expect({
        scenario: scenario.scenarioId,
        missed: scenario.review.missedLines,
      }).toEqual({ scenario: scenario.scenarioId, missed: [] })
    }
  })
})

describe("the deterministic evaluation", () => {
  it("runs on contract fakes, with no key and no network", () => {
    if (report.mode !== "fixtures") return

    expect(report.providers).toEqual({
      ocr: "contract-fake",
      extraction: "contract-fake",
      rerank: "contract-fake",
    })
  })

  it("scores identity, extraction, and retrieval on every curated line", () => {
    if (report.mode !== "fixtures") return

    expect(report.totals.lines).toBe(18)
    expect(report.totals.customerCorrect).toBe(3)
    expect(report.totals.extractionComplete).toBe(3)
    expect(report.totals.quantityCorrect).toBe(report.totals.lines)
    expect(report.totals.shortlistHits).toBe(report.totals.lines)
    expect(report.totals.topThreeHits).toBe(report.totals.lines)
    expect(report.totals.priced).toBe(3)
    expect(report.totals.delivered).toBe(3)
  })

  /**
   * The fake reranker does not agree with the fixtures everywhere, and this
   * asserts the shape of that disagreement rather than the disagreement away.
   * What matters is that a line it got wrong is a line it stopped to ask about:
   * the evaluation approves proposals unchanged, so an owner reviewing the same
   * node would have corrected it. A line settled without asking is the failure
   * this pins to zero.
   */
  it("settles no line by itself that the fixtures answer differently", () => {
    if (report.mode !== "fixtures") return

    expect(report.totals.divergedWithoutAsking).toBe(0)
    expect(
      report.totals.selectionCorrect + report.totals.divergedAfterAsking
    ).toBe(report.totals.lines)
  })

  it("matches the committed summary System details serves", () => {
    if (report.mode !== "fixtures") return

    expect(report.summary).toEqual(summarize(report))
    expect(report.summary).toEqual(REFERENCE_EVALUATION)
  })
})
