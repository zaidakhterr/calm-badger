import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { driveRun, type RunFetcher } from "../evals/_task"
import { SCENARIOS } from "../worker/scenarios"

const fetcher: RunFetcher = (path, init) =>
  exports.default.fetch(`https://example.test${path}`, init)

describe("the three curated workflows", () => {
  it("structures 18 lines, delivers three quotes, and changes products only after review", async () => {
    let lines = 0
    let delivered = 0
    for (const scenario of SCENARIOS) {
      const run = await driveRun(
        fetcher,
        { scenarioId: scenario.id, sources: ["Email body"] },
        { pollAttempts: 600, pollIntervalMs: 25 }
      )
      lines += run.structure.validated?.lineItems.length ?? 0
      delivered += Number(
        run.workflowState === "delivered" && run.delivery !== null
      )
      for (const line of run.quote?.lines ?? []) {
        const matched = run.matches.lines.find(
          (entry) => entry.position === line.position
        )
        if (line.sku !== matched?.sku) {
          expect(
            run.review?.items.some(
              (item) =>
                item.kind === "product" && item.position === line.position
            )
          ).toBe(true)
        }
      }
    }
    expect(lines).toBe(18)
    expect(delivered).toBe(3)
  })
})
