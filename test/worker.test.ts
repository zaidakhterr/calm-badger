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
