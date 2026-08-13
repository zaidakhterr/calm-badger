import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

describe("RFQ Relay Worker", () => {
  it("reports healthy local D1, R2, and Workflow bindings", async () => {
    const response = await exports.default.fetch(
      "https://example.test/api/health"
    )
    const body = await response.json<{
      status: string
      environment: string
      services: Record<string, string>
    }>()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(body).toMatchObject({
      status: "ok",
      environment: env.APP_ENV,
      services: {
        d1: "ready",
        r2: "ready",
        workflow: "configured",
      },
    })
    expect(env.RFQ_WORKFLOW).toBeDefined()
  })

  it("describes the system from live configuration without leaking secrets", async () => {
    const response = await exports.default.fetch(
      "https://example.test/api/system"
    )

    expect(response.status).toBe(200)

    const { system } = await response.json<{
      system: {
        architecture: { pieces: unknown[]; steps: string[] }
        providers: { role: string; provider: string; live: boolean }[]
        catalog: { activeProducts: number; customers: number }
        retrieval: { shortlistSize: number; steps: string[] }
        retention: { state: string }
        rateLimit: { state: string; summary: string }
        adapterContract: { adapters: { id: string; simulated: boolean }[] }
        evaluation: { state: string }
      }
    }>()

    // Catalogue scale is counted, not asserted in copy.
    expect(system.catalog.activeProducts).toBeGreaterThan(0)
    expect(system.catalog.customers).toBeGreaterThan(0)
    expect(system.architecture.steps).toContain("Match products")
    expect(system.retrieval.shortlistSize).toBeGreaterThan(0)
    expect(system.adapterContract.adapters.map((entry) => entry.id)).toEqual([
      "corebridge-sandbox",
      "generic-erp-webhook",
    ])
    for (const adapter of system.adapterContract.adapters) {
      expect(adapter.simulated).toBe(true)
    }

    // The deterministic fake is reported honestly rather than as a live model.
    const configuredOcr: string = env.OCR_PROVIDER
    const ocr = system.providers.find((entry) =>
      entry.role.includes("Document reading")
    )!
    expect(ocr.provider).toBe(configuredOcr)
    expect(ocr.live).toBe(configuredOcr !== "contract-fake")

    // Retention and rate limiting are enforced by this build, so the drawer
    // states them as facts rather than as intentions.
    expect(system.retention.state).toBe("enforced")
    expect(system.rateLimit.state).toBe("enforced")
    expect(system.rateLimit.summary).toContain("5 runs per hour")
    // Scored evaluation is still designed only, and still says so.
    expect(system.evaluation.state).toBe("planned")

    const serialized = JSON.stringify(system)
    expect(serialized).not.toContain("API_KEY")
    expect(serialized.toLowerCase()).not.toContain("secret")
    expect(serialized.toLowerCase()).not.toContain("expected")
    if (env.MISTRAL_API_KEY) {
      expect(serialized).not.toContain(env.MISTRAL_API_KEY)
    }
  })

  it("rejects unsupported system-details methods", async () => {
    const response = await exports.default.fetch(
      "https://example.test/api/system",
      { method: "POST" }
    )

    expect(response.status).toBe(405)
  })

  it("returns a structured 404 for unknown API routes", async () => {
    const response = await exports.default.fetch(
      "https://example.test/api/unknown"
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: "API route not found",
    })
  })

  it("rejects unsupported health methods", async () => {
    const response = await exports.default.fetch(
      "https://example.test/api/health",
      { method: "POST" }
    )

    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })
})
