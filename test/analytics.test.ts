import { env, exports } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"

import { bucketPath, logRoute } from "../worker/analytics"
import {
  capturedAnalyticsEvents,
  resetCapturedAnalyticsEvents,
} from "../worker/providers/contract-fake-analytics"

/**
 * What the demo is allowed to measure, asserted against the envelopes that
 * would have been sent. The contract fake records them; no network exists here,
 * no project key is configured, and no browser tracker is ever loaded.
 */

const base = "https://example.test"

/** Words that would mean business content had escaped into an event. */
const FORBIDDEN = [
  "rfq",
  "customer",
  "sku",
  "price",
  "eur",
  "prompt",
  "email",
  "@",
  "filename",
  ".pdf",
  ".png",
  "error:",
  "stack",
]

let address = 100

function startRun(scenarioId = "routine-replenishment") {
  address += 1

  return exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `192.0.2.${address % 250}`,
    },
    body: JSON.stringify({ scenarioId }),
  })
}

beforeEach(() => {
  resetCapturedAnalyticsEvents()
})

describe("what the funnel records", () => {
  it("records a started run as buckets, keyed by the run rather than a person", async () => {
    const response = await startRun("messy-forwarded-request")
    const { run } = await response.json<{ run: { viewId: string } }>()

    const runId = (
      await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
        .bind(run.viewId)
        .first<{ id: string }>()
    )?.id

    const started = capturedAnalyticsEvents().find(
      (event) => event.event === "rfq_run_started"
    )

    expect(started).toBeDefined()
    // The run is the subject of its own funnel: no visitor identity is joined
    // across runs, and the view identifier is never sent.
    expect(started!.distinctId).toBe(runId)
    expect(started!.properties).toEqual({
      source_kind: "curated",
      scenario_id: "messy-forwarded-request",
    })
    expect(JSON.stringify(started)).not.toContain(run.viewId)
  })

  it("drops any property that is not an approved bucket", async () => {
    const rejected = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.201",
      },
      body: JSON.stringify({ scenarioId: "definitely-not-a-scenario" }),
    })

    expect(rejected.status).toBe(400)

    const event = capturedAnalyticsEvents().find(
      (entry) => entry.event === "rfq_run_rejected"
    )

    // A reason code from the fixed list, and nothing about what was submitted.
    expect(event!.properties).toEqual({
      source_kind: "curated",
      reason: "unknown_scenario",
    })
    expect(JSON.stringify(event)).not.toContain("definitely-not-a-scenario")
  })

  it("records reaching the hourly limit without recording who reached it", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await exports.default.fetch(`${base}/api/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.210",
        },
        body: JSON.stringify({ scenarioId: "routine-replenishment" }),
      })
    }

    const limited = capturedAnalyticsEvents().find(
      (event) => event.event === "rfq_run_rate_limited"
    )

    expect(limited).toBeDefined()
    expect(limited!.properties).toEqual({ source_kind: "curated" })
    // The identifier is the rotating hash, never the address it came from.
    expect(limited!.distinctId).toMatch(/^[0-9a-f]{64}$/)
    expect(limited!.distinctId).not.toContain("192.0.2.210")
  })

  it("captures a pageview without the view identifier or the query string", async () => {
    const response = await exports.default.fetch(
      `${base}/runs/some-view-identifier?utm_source=mail&q=acme%20gmbh`
    )

    expect(response.status).toBe(200)

    const pageview = capturedAnalyticsEvents().find(
      (event) => event.event === "$pageview"
    )

    expect(pageview).toBeDefined()

    expect(pageview!.properties.$pathname).toBe("/runs/[view]")
    const serialized = JSON.stringify(pageview)
    expect(serialized).not.toContain("some-view-identifier")
    expect(serialized).not.toContain("utm_source")
    expect(serialized).not.toContain("acme")
  })

  it("never captures an API path as a pageview", async () => {
    await exports.default.fetch(`${base}/api/scenarios`)

    expect(
      capturedAnalyticsEvents().filter((event) => event.event === "$pageview")
    ).toEqual([])
  })

  it("keeps every captured event free of business content", async () => {
    await startRun()
    await startRun("ambiguous-replacement-parts")

    const serialized = JSON.stringify(capturedAnalyticsEvents()).toLowerCase()

    for (const term of FORBIDDEN) {
      // Event names themselves are the one place "rfq" legitimately appears.
      const withoutNames = serialized.replaceAll("rfq_run", "")
      expect(withoutNames).not.toContain(term)
    }
  })
})

describe("what a log line and a pageview may say about a URL", () => {
  it("buckets a path to a route", () => {
    expect(bucketPath("/")).toBe("/")
    expect(bucketPath("/runs/abc123")).toBe("/runs/[view]")
    expect(bucketPath("/runs/abc123/")).toBe("/runs/[view]")
    expect(bucketPath("/something/else")).toBe("/[other]")
  })

  it("replaces identifiers in an API route", () => {
    expect(logRoute("/api/runs")).toBe("/api/runs")
    expect(logRoute("/api/runs/abc123")).toBe("/api/runs/:viewId")
    expect(logRoute("/api/runs/abc123/review/decisions")).toBe(
      "/api/runs/:viewId/review/decisions"
    )
    expect(logRoute("/api/runs/abc123/sources/9e1c")).toBe(
      "/api/runs/:viewId/sources/:sourceId"
    )
  })
})
