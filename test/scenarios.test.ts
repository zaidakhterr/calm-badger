import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import type { ScenarioPreview } from "../worker/scenarios"

const base = "https://example.test"

async function readScenarios(): Promise<ScenarioPreview[]> {
  const response = await exports.default.fetch(`${base}/api/scenarios`)

  expect(response.status).toBe(200)

  const body = await response.json<{ scenarios: ScenarioPreview[] }>()
  return body.scenarios
}

describe("choosing a curated request", () => {
  it("offers the three named scenarios with the messy one featured", async () => {
    const scenarios = await readScenarios()

    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      "Routine replenishment",
      "Messy forwarded request",
      "Ambiguous replacement parts",
    ])

    const featured = scenarios.filter((scenario) => scenario.featured)
    expect(featured).toHaveLength(1)
    expect(featured[0].id).toBe("messy-forwarded-request")
  })

  it("previews an email, an inline image, a PDF, six lines, and a difficulty", async () => {
    for (const scenario of await readScenarios()) {
      expect(scenario.email.from.name.length).toBeGreaterThan(0)
      expect(scenario.email.from.email).toMatch(/@[\w-]+\.example$/)
      expect(scenario.email.subject.length).toBeGreaterThan(0)
      expect(scenario.email.body.length).toBeGreaterThan(2)
      expect(scenario.email.signature.length).toBeGreaterThan(1)

      expect(scenario.inlineImage.kind).toBe("image")
      expect(scenario.inlineImage.url).toMatch(/\.png$/)
      expect(scenario.pdfAttachment.kind).toBe("pdf")
      expect(scenario.pdfAttachment.url).toMatch(/\.pdf$/)

      expect(scenario.requestedItems).toHaveLength(6)
      expect(scenario.requestedItems.map((item) => item.position)).toEqual([
        1, 2, 3, 4, 5, 6,
      ])
      for (const item of scenario.requestedItems) {
        expect(item.reference.length).toBeGreaterThan(0)
        expect(item.quantity).toBeGreaterThan(0)
        expect(item.unit.length).toBeGreaterThan(0)
        expect(item.note.length).toBeGreaterThan(0)
      }

      expect(["Low", "Medium", "High"]).toContain(scenario.difficulty.level)
      expect(scenario.difficulty.summary.length).toBeGreaterThan(40)
      expect(scenario.difficulty.expectedReview.length).toBeGreaterThan(0)
    }
  })

  it("marks the forwarded scenario as a forwarded thread", async () => {
    const scenarios = await readScenarios()
    const messy = scenarios.find(
      (scenario) => scenario.id === "messy-forwarded-request"
    )!

    expect(messy.email.forwarded).not.toBeNull()
    expect(messy.email.forwarded?.from).toContain("@")
    expect(
      scenarios.filter((scenario) => scenario.email.forwarded !== null)
    ).toHaveLength(1)
  })

  it("never serves the expected outcome of a scenario", async () => {
    const response = await exports.default.fetch(`${base}/api/scenarios`)
    const payload = await response.text()

    for (const leaked of [
      "expectedSku",
      "auto_accept",
      "model_match",
      "goldScenario",
      "expectedReviewPositions",
    ]) {
      expect(payload).not.toContain(leaked)
    }
  })

  it("rejects unsupported methods", async () => {
    const response = await exports.default.fetch(`${base}/api/scenarios`, {
      method: "POST",
    })

    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })
})
