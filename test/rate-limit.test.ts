import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { checkRateLimit } from "../worker/rate-limit"

/**
 * The public boundary of the demo: how much processing one visitor may start,
 * what a visitor is allowed to be recorded as, and what is never limited.
 */

const base = "https://example.test"

function startRun(address: string, scenarioId = "routine-replenishment") {
  return exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": address,
    },
    body: JSON.stringify({ scenarioId }),
  })
}

describe("processing limits", () => {
  it("allows five runs an hour from one place and then answers plainly", async () => {
    const address = "203.0.113.10"
    const statuses: number[] = []

    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push((await startRun(address)).status)
    }

    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201])
    expect(statuses[5]).toBe(429)

    const refused = await startRun(address)
    const body = await refused.json<{
      error: string
      limit: number
      windowSeconds: number
      retryAfterSeconds: number
    }>()

    expect(refused.status).toBe(429)
    expect(body.limit).toBe(5)
    expect(body.windowSeconds).toBe(3600)
    expect(body.retryAfterSeconds).toBeGreaterThan(0)
    expect(Number(refused.headers.get("retry-after"))).toBe(
      body.retryAfterSeconds
    )
    // A friendly boundary, not an account problem.
    expect(body.error).toMatch(/try again/i)
    expect(body.error).not.toMatch(/error|denied|blocked|forbidden/i)
  })

  it("counts each place separately", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await startRun("203.0.113.20")).status).toBe(201)
    }

    expect((await startRun("203.0.113.20")).status).toBe(429)
    expect((await startRun("203.0.113.21")).status).toBe(201)
  })

  it("persists no address, only a rotating hash", async () => {
    const address = "203.0.113.30"
    await startRun(address)

    const rows = await env.DB.prepare(
      `SELECT bucket_hash, window_start, window_end, hits FROM rate_limit_windows`
    ).all<{
      bucket_hash: string
      window_start: string
      window_end: string
      hits: number
    }>()

    expect(rows.results.length).toBe(1)
    const [row] = rows.results
    expect(row.hits).toBe(1)
    expect(row.bucket_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows.results)).not.toContain(address)

    // The window is part of what is hashed, so the same visitor is a different
    // key in the next hour and nothing accumulates into a per-person history.
    expect(Date.parse(row.window_end) - Date.parse(row.window_start)).toBe(
      60 * 60 * 1000
    )
  })

  it("starts the same visitor over in the next hour, under an unrelated key", async () => {
    // The window is a parameter, so the rollover is driven directly rather
    // than waited an hour for. One synthetic visitor, two adjacent hours.
    const request = new Request(`${base}/api/runs`, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.60" },
    })

    const firstHour = new Date("2026-08-13T10:15:00.000Z")
    const nextHour = new Date("2026-08-13T11:05:00.000Z")

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await checkRateLimit(env, request, firstHour)).allowed).toBe(true)
    }

    const spent = await checkRateLimit(env, request, firstHour)
    expect(spent.allowed).toBe(false)
    expect(spent.remaining).toBe(0)

    // The hour turns over: the count starts again, and the counter it starts
    // in is a different row entirely.
    const rolled = await checkRateLimit(env, request, nextHour)
    expect(rolled.allowed).toBe(true)
    expect(rolled.remaining).toBe(4)
    expect(Date.parse(rolled.resetAt)).toBe(
      Date.parse("2026-08-13T12:00:00.000Z")
    )

    const rows = await env.DB.prepare(
      `SELECT bucket_hash, window_start, hits FROM rate_limit_windows
        ORDER BY window_start ASC`
    ).all<{ bucket_hash: string; window_start: string; hits: number }>()

    expect(rows.results.map((row) => row.hits)).toEqual([6, 1])
    expect(rows.results.map((row) => row.window_start)).toEqual([
      "2026-08-13T10:00:00.000Z",
      "2026-08-13T11:00:00.000Z",
    ])

    // Nothing links the two hours: the window is part of the hashed material,
    // so the same visitor is an unrelated key and no per-person history can
    // accumulate across windows.
    const [before, after] = rows.results
    expect(before.bucket_hash).not.toBe(after.bucket_hash)
    expect(after.bucket_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("never limits reading, sharing, or resetting an existing run", async () => {
    const address = "203.0.113.40"
    const created = await startRun(address)
    const { run, ownerCapability } = await created.json<{
      run: { viewId: string }
      ownerCapability: string
    }>()

    for (let attempt = 0; attempt < 5; attempt++) {
      await startRun(address)
    }

    expect((await startRun(address)).status).toBe(429)

    // The visitor is over the limit, and every read of what they already have
    // still works.
    for (let attempt = 0; attempt < 3; attempt++) {
      const view = await exports.default.fetch(
        `${base}/api/runs/${run.viewId}`,
        { headers: { "cf-connecting-ip": address } }
      )
      expect(view.status).toBe(200)
    }

    const reset = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/reset`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerCapability}`,
          "cf-connecting-ip": address,
        },
      }
    )

    expect(reset.status).toBe(200)
  })

  it("requires a supported run media type and matches it case-insensitively", async () => {
    const upperJson = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "APPLICATION/JSON; CHARSET=UTF-8",
        "cf-connecting-ip": "203.0.113.70",
      },
      body: JSON.stringify({ scenarioId: "routine-replenishment" }),
    })
    expect(upperJson.status).toBe(201)

    const form = new FormData()
    form.set("emailBody", "Please quote the attached request.")
    const encodedForm = new Request(`${base}/api/runs`, {
      method: "POST",
      body: form,
    })
    const multipartType = encodedForm.headers.get("content-type")!
    const upperMultipart = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": multipartType.replace(
          "multipart/form-data",
          "MULTIPART/FORM-DATA"
        ),
        "cf-connecting-ip": "203.0.113.71",
      },
      body: await encodedForm.arrayBuffer(),
    })
    expect(upperMultipart.status).toBe(201)

    for (const contentType of [
      null,
      "text/plain",
      "application/json-patch+json",
    ]) {
      const headers = new Headers({
        "cf-connecting-ip": "203.0.113.72",
      })
      if (contentType) headers.set("content-type", contentType)

      const response = await exports.default.fetch(`${base}/api/runs`, {
        method: "POST",
        headers,
        body: new TextEncoder().encode(
          JSON.stringify({ scenarioId: "routine-replenishment" })
        ),
      })
      expect(response.status).toBe(415)
      expect(response.headers.get("accept-post")).toBe(
        "application/json, multipart/form-data"
      )
    }
  })

  it("abandons an oversized JSON stream before parsing or storage", async () => {
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS runs FROM runs`
    ).first<{ runs: number }>()
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 32; chunk++) {
          controller.enqueue(new Uint8Array(1024).fill(0x20))
        }
        controller.close()
      },
    })

    const response = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.73",
      },
      body: oversized,
      // @ts-expect-error a streamed request body needs duplex in this runtime
      duplex: "half",
    })

    expect(response.status).toBe(400)
    await expect(response.json<{ error: string }>()).resolves.toEqual({
      error: "The JSON run request is too large",
    })
    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS runs FROM runs`
    ).first<{ runs: number }>()
    expect(after?.runs).toBe(before?.runs)
  })

  it("refuses an oversized upload before it is buffered or stored", async () => {
    const before = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM runs) AS runs,
              (SELECT COUNT(*) FROM run_sources) AS sources`
    ).first<{ runs: number; sources: number }>()

    // No content-length is declared, and the stream is larger than the upload
    // ceiling: the body is abandoned at the bound rather than held in memory.
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 24; chunk++) {
          controller.enqueue(new Uint8Array(512 * 1024))
        }
        controller.close()
      },
    })

    const response = await exports.default.fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=----rfqrelay",
        "cf-connecting-ip": "203.0.113.50",
      },
      body: oversized,
      // @ts-expect-error a streamed request body needs duplex in this runtime
      duplex: "half",
    })

    expect(response.status).toBe(400)
    const refusal = await response.json<{ error: string }>()
    expect(refusal.error).toContain("10 MB")

    // Nothing was persisted for the rejected request, so no provider capacity
    // and no storage was spent on it.
    const after = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM runs) AS runs,
              (SELECT COUNT(*) FROM run_sources) AS sources`
    ).first<{ runs: number; sources: number }>()

    expect(after?.runs).toBe(before?.runs)
    expect(after?.sources).toBe(before?.sources)
  })
})
