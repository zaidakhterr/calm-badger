import { env, exports } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"

import { bucketPath, FUNNEL_EVENTS, logRoute } from "../worker/analytics"
import { selectAnalyticsProvider } from "../worker/providers/analytics"
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

/**
 * The sweep itself. Event names are the one place a forbidden word may appear,
 * so every declared funnel name is removed before the envelopes are searched —
 * rather than exempting a substring, which would exempt real content too.
 */
function expectNoBusinessContent(events: unknown[]): void {
  let serialized = JSON.stringify(events).toLowerCase()

  for (const name of FUNNEL_EVENTS) {
    serialized = serialized.replaceAll(name, "")
  }

  for (const term of FORBIDDEN) {
    expect(serialized).not.toContain(term)
  }
}

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

/* -------------------------------------------------------------------------- */
/* Driving a run to the end of the funnel                                     */
/* -------------------------------------------------------------------------- */

type ReviewItem = {
  id: string
  kind: string
  proposal: { sku: string | null }
  alternatives: { value: string }[]
}

type Review = { state: string; items: ReviewItem[] }

async function readWorkflowState(viewId: string): Promise<string> {
  const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
  const { run } = await response.json<{ run: { workflowState: string } }>()

  return run.workflowState
}

async function waitForState(viewId: string, ...accept: string[]) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await readWorkflowState(viewId)
    if (accept.includes(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Never observed ${accept.join(" or ")}`)
}

async function readReview(viewId: string): Promise<Review> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/review`
  )

  return (await response.json<{ review: Review }>()).review
}

/** Answers every open question so the review can be approved. */
function straightforwardDecisions(review: Review) {
  return review.items.map((item) => {
    if (item.kind === "quantity") {
      return { itemId: item.id, action: "quantity", quantity: 10 }
    }

    if (item.kind === "customer") {
      return { itemId: item.id, action: "customer", customerId: "CUST-1001" }
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

    expectNoBusinessContent(capturedAnalyticsEvents())
  })

  it("records the far end of the funnel — a decision and a delivery — as two words", async () => {
    // The two events no earlier test reaches, captured through the public API
    // the same way a visitor would produce them.
    const created = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.220",
      },
      body: JSON.stringify({ scenarioId: "messy-forwarded-request" }),
    })

    expect(created.status).toBe(201)
    const { run, ownerCapability } = await created.json<{
      run: { viewId: string }
      ownerCapability: string
    }>()

    expect(await waitForState(run.viewId, "awaiting_review", "failed")).toBe(
      "awaiting_review"
    )

    const recorded = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/review/decisions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerCapability}`,
        },
        body: JSON.stringify({
          decisions: straightforwardDecisions(await readReview(run.viewId)),
        }),
      }
    )

    expect(recorded.status).toBe(200)

    const approved = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerCapability}`,
        },
        body: JSON.stringify({ action: "approve" }),
      }
    )

    expect(approved.status).toBe(200)
    expect(await waitForState(run.viewId, "estimate_built", "failed")).toBe(
      "estimate_built"
    )

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

    const runId = (
      await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
        .bind(run.viewId)
        .first<{ id: string }>()
    )?.id

    const decision = capturedAnalyticsEvents().find(
      (event) => event.event === "rfq_review_decided"
    )
    const delivery = capturedAnalyticsEvents().find(
      (event) => event.event === "rfq_quote_delivered"
    )

    // What was decided and where it went, keyed by the run. Not which items
    // were corrected, not what they were corrected to, not what was sent.
    expect(decision).toBeDefined()
    expect(decision!.distinctId).toBe(runId)
    expect(decision!.properties).toEqual({ decision: "approve" })

    expect(delivery).toBeDefined()
    expect(delivery!.distinctId).toBe(runId)
    expect(delivery!.properties).toEqual({ adapter: "generic-erp-webhook" })

    expectNoBusinessContent([decision!, delivery!])
  })
})

describe("which analytics provider a deployment gets", () => {
  function envWith(overrides: Record<string, string>): Env {
    return { ...env, ...overrides }
  }

  it("refuses to send from anywhere but production, even with a key", () => {
    // A local checkout carries a real project key in `.dev.vars`, and
    // `APP_ENV` comes from `wrangler.jsonc`. Without this guard a developer's
    // own traffic lands in the deployed project as public usage.
    const local = selectAnalyticsProvider(
      envWith({
        ANALYTICS_PROVIDER: "posthog",
        POSTHOG_API_KEY: "phc-a-real-looking-project-key",
        APP_ENV: "development",
      })
    )

    expect(local.name).toBe("none")

    const deployed = selectAnalyticsProvider(
      envWith({
        ANALYTICS_PROVIDER: "posthog",
        POSTHOG_API_KEY: "phc-a-real-looking-project-key",
        APP_ENV: "production",
      })
    )

    expect(deployed.name).toBe("posthog-eu")
  })

  it("still disables measurement rather than failing when nothing is configured", () => {
    expect(
      selectAnalyticsProvider(
        envWith({
          ANALYTICS_PROVIDER: "posthog",
          POSTHOG_API_KEY: "",
          APP_ENV: "production",
        })
      ).name
    ).toBe("none")

    expect(
      selectAnalyticsProvider(envWith({ ANALYTICS_PROVIDER: "none" })).name
    ).toBe("none")
  })

  it("refuses the deterministic recorder in production", () => {
    expect(() =>
      selectAnalyticsProvider(
        envWith({ ANALYTICS_PROVIDER: "contract-fake", APP_ENV: "production" })
      )
    ).toThrow()

    expect(
      selectAnalyticsProvider(
        envWith({ ANALYTICS_PROVIDER: "contract-fake", APP_ENV: "test" })
      ).name
    ).toBe("contract-fake")
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
