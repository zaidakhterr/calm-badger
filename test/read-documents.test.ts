/**
 * Provider contract for reading documents.
 *
 * These tests drive the public workflow boundary — create a run, wait for the
 * persisted step, read the evidence projection — with the deterministic
 * contract-fake OCR provider selected in `vitest.config.ts`. No test reaches a
 * live provider and none of them assert prompt text or internal calls.
 */

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import {
  estimateOcrCostUsd,
  OcrPageLimitError,
  selectOcrProvider,
} from "../worker/providers/ocr"
import {
  createMistralOcrProvider,
  mistralPageProbe,
} from "../worker/providers/mistral-ocr"
import { readDocuments } from "../worker/read-documents"
import {
  MAX_OCR_PAGES_PER_RUN,
  storeSources,
  type PreparedSource,
} from "../worker/sources"

const base = "https://example.test"

/** The bindings of the test isolate with a deliberate misconfiguration. */
function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides }
}

type RunStep = {
  key: string
  status: string
  summary: string
  startedAt: string | null
  completedAt: string | null
}

type Run = {
  viewId: string
  status: string
  workflowState: string
  source: { kind: string; scenarioId: string | null }
  steps: RunStep[]
}

type Evidence = {
  stepKey: string
  state: string
  message: string | null
  provider: string | null
  model: string | null
  totals: {
    sourceCount: number
    pageCount: number
    pagesProcessed: number
    providerLatencyMs: number
    estimatedCostUsd: number | null
    elapsedMs: number
  } | null
  sources: {
    id: string
    kind: string
    label: string
    mediaType: string
    byteSize: number
    previewUrl: string | null
    reader: string | null
    latencyMs: number | null
    pagesProcessed: number | null
    estimatedCostUsd: number | null
    sanitizedResponse: unknown
    pages: {
      pageNumber: number
      markdown: string
      width: number | null
      height: number | null
      dpi: number | null
      regions: { id: string; box: number[] }[]
    }[]
  }[]
}

async function createCuratedRun(scenarioId = "messy-forwarded-request") {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)
  return response.json<{ run: Run; ownerCapability: string }>()
}

async function submitCustomRun(
  form: FormData
): Promise<{ status: number; body: { run?: Run; error?: string } }> {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    body: form,
  })

  return {
    status: response.status,
    body: await response.json<{ run?: Run; error?: string }>(),
  }
}

function pdfFile(name: string, lines: string[]): File {
  // A minimal text-drawing PDF; the same construction as the curated assets.
  const content = ["BT", "/F1 10 Tf", ...lines.map((l) => `(${l}) Tj T*`), "ET"]
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [0 0 595 842] >>\nendobj\n4 0 obj\nstream\n${content.join("\n")}\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n`

  return new File([body], name, { type: "application/pdf" })
}

/** Small enough to evade a byte cap while declaring many distinct PDF pages. */
function compactManyPagePdf(name: string, pageCount: number): File {
  const pages = Array.from(
    { length: pageCount },
    (_, index) =>
      `${index + 1} 0 obj\n<< /Type /Page /MediaBox [0 0 10 10] >>\nendobj`
  ).join("\n")

  return new File([`%PDF-1.4\n${pages}\ntrailer\n<< >>\n%%EOF\n`], name, {
    type: "application/pdf",
  })
}

function pngFile(name: string): File {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR width/height, so the fake reports real image dimensions.
  new DataView(bytes.buffer).setUint32(16, 320)
  new DataView(bytes.buffer).setUint32(20, 200)

  return new File([bytes], name, { type: "image/png" })
}

async function waitForStep(
  viewId: string,
  stepKey: string,
  statuses: string[]
): Promise<RunStep> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
    const { run } = await response.json<{ run: Run }>()
    const step = run.steps.find((candidate) => candidate.key === stepKey)!

    if (statuses.includes(step.status)) return step

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Step ${stepKey} never reached ${statuses.join(" or ")}`)
}

async function readEvidence(viewId: string): Promise<Evidence> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/documents`
  )

  expect(response.status).toBe(200)
  const body = await response.json<{ evidence: Evidence }>()
  return body.evidence
}

describe("reading the sources of a curated request", () => {
  it("stores the email body, inline image, and PDF privately", async () => {
    const { run } = await createCuratedRun()

    const sources = await env.DB.prepare(
      `SELECT kind, media_type, byte_size, storage_key FROM run_sources
        WHERE run_id = (SELECT id FROM runs WHERE view_id = ?)
        ORDER BY position ASC`
    )
      .bind(run.viewId)
      .all<{
        kind: string
        media_type: string
        byte_size: number
        storage_key: string
      }>()

    expect(sources.results.map((source) => source.kind)).toEqual([
      "email_body",
      "inline_image",
      "attachment",
    ])
    expect(sources.results.map((source) => source.media_type)).toEqual([
      "text/plain",
      "image/png",
      "application/pdf",
    ])

    for (const source of sources.results) {
      expect(source.byte_size).toBeGreaterThan(0)
      expect(source.storage_key).toMatch(
        /^runs\/curated\/[0-9a-f-]+\/sources\//
      )
      const object = await env.ARTIFACTS.get(source.storage_key)
      expect(object).not.toBeNull()
    }
  })

  it("never stores the scenario's expected-outcome preview copy", async () => {
    const { run } = await createCuratedRun()

    const emailBody = await env.DB.prepare(
      `SELECT s.storage_key FROM run_sources s
         JOIN runs r ON r.id = s.run_id
        WHERE r.view_id = ? AND s.kind = 'email_body'`
    )
      .bind(run.viewId)
      .first<{ storage_key: string }>()

    const stored = await env.ARTIFACTS.get(emailBody!.storage_key)
    const text = await stored!.text()

    // These phrases only exist in the landing-page line notes.
    for (const leaked of [
      "Matches a known alias exactly",
      "Typographical variant of a stocked panel filter",
      "Legacy number for an archived seal kit",
      "Fits both the 2 mm and the 3 mm gasket",
    ]) {
      expect(text).not.toContain(leaked)
    }

    const everything = JSON.stringify(await readEvidence(run.viewId))
    expect(everything).not.toContain("Matches a known alias exactly")
  })

  it("completes the persisted step with source count, pages, and elapsed time", async () => {
    const { run } = await createCuratedRun("routine-replenishment")

    const atCreation = run.steps.find((step) => step.key === "read-documents")!
    // The durable orchestrator owns this step: it is queued at creation and
    // may already be running by the time the response is read.
    expect(["waiting", "active", "complete"]).toContain(atCreation.status)

    const step = await waitForStep(run.viewId, "read-documents", ["complete"])

    expect(step.summary).toMatch(
      /Read 3 sources into \d+ pages in (\d+ ms|\d+\.\d s)\./
    )
    expect(step.startedAt).not.toBeNull()
    expect(step.completedAt).not.toBeNull()
  })

  it("exposes page evidence with provenance, model, latency, usage, and cost", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "read-documents", ["complete"])

    const evidence = await readEvidence(run.viewId)

    expect(evidence.state).toBe("complete")
    expect(evidence.provider).toBe("contract-fake")
    expect(evidence.model).toContain("mistral-ocr")
    expect(evidence.totals).toMatchObject({ sourceCount: 3 })
    expect(evidence.totals!.pageCount).toBeGreaterThanOrEqual(3)
    expect(evidence.totals!.pagesProcessed).toBe(2)
    expect(evidence.totals!.estimatedCostUsd).toBeCloseTo(0.002, 6)
    expect(evidence.totals!.elapsedMs).toBeGreaterThanOrEqual(0)

    const [email, image, pdf] = evidence.sources

    expect(email.kind).toBe("email_body")
    expect(email.reader).toBe("email-body")
    expect(email.previewUrl).toBeNull()
    expect(email.pages[0].markdown).toContain("Spandau")

    expect(image.kind).toBe("inline_image")
    expect(image.reader).toBe("ocr-provider")
    expect(image.previewUrl).toBe(`/api/runs/${run.viewId}/sources/${image.id}`)
    expect(image.pages[0].regions.length).toBeGreaterThan(0)
    expect(image.pages[0].regions[0].box).toHaveLength(4)

    expect(pdf.kind).toBe("attachment")
    expect(pdf.mediaType).toBe("application/pdf")
    expect(pdf.pages[0].pageNumber).toBe(1)
    // Text read from the attachment, page 1.
    expect(pdf.pages[0].markdown).toContain("NX-FLT-1120")
    expect(pdf.latencyMs).toBeGreaterThanOrEqual(0)
    expect(pdf.pagesProcessed).toBe(1)
    expect(pdf.estimatedCostUsd).toBeCloseTo(0.001, 6)
    expect(pdf.sanitizedResponse).not.toBeNull()
  })

  it("shows an unknown cost, not zero, when the page price is not configured", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "read-documents", ["complete"])

    const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
      .bind(run.viewId)
      .first<{ id: string }>()

    // The same sources, read by a deployment whose page price was never set.
    const outcome = await readDocuments(
      envWith({ OCR_COST_PER_1000_PAGES_USD: "" }),
      row!.id
    )

    expect(outcome.state).toBe("complete")

    const evidence = await readEvidence(run.viewId)
    const pdf = evidence.sources.find(
      (source) => source.mediaType === "application/pdf"
    )!

    expect(evidence.totals!.estimatedCostUsd).toBeNull()
    expect(pdf.estimatedCostUsd).toBeNull()
  })

  it("serves the original source through the Worker and never exposes secrets", async () => {
    const { run } = await createCuratedRun()
    await waitForStep(run.viewId, "read-documents", ["complete"])

    const evidence = await readEvidence(run.viewId)
    const image = evidence.sources.find(
      (source) => source.kind === "inline_image"
    )!

    const preview = await exports.default.fetch(`${base}${image.previewUrl}`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-type")).toBe("image/png")
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0)

    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain("authorization")
    expect(serialized).not.toContain("Bearer")
    expect(serialized).not.toContain("api.mistral.ai")
    expect(serialized).not.toContain("capability")
    expect(serialized).not.toContain("storageKey")
  })

  it("gives a shared viewer the same read-only evidence", async () => {
    const { run } = await createCuratedRun()
    await waitForStep(run.viewId, "read-documents", ["complete"])

    const owned = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/documents`
    )
    const shared = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/documents`,
      { headers: { authorization: "Bearer not-the-owner" } }
    )

    expect(await owned.text()).toBe(await shared.text())
  })
})

describe("submitting a custom request", () => {
  it("reads an email body with a PDF and an image", async () => {
    const form = new FormData()
    form.set("emailBody", "Please quote 12 panel filters for the north depot.")
    form.append("files", pdfFile("own-list.pdf", ["POS 1 PANEL FILTER 592"]))
    form.append("files", pngFile("own-photo.png"))

    const { status, body } = await submitCustomRun(form)
    expect(status).toBe(201)

    const run = body.run!
    expect(run.source).toEqual({ kind: "custom", scenarioId: null })

    await waitForStep(run.viewId, "read-documents", ["complete"])
    const evidence = await readEvidence(run.viewId)

    expect(evidence.sources.map((source) => source.kind)).toEqual([
      "email_body",
      "attachment",
      "inline_image",
    ])
    expect(evidence.sources[0].pages[0].markdown).toContain("north depot")
    expect(evidence.sources[1].pages[0].markdown).toContain("PANEL FILTER")
    expect(evidence.sources[2].pages[0].width).toBe(320)

    const keys = await env.DB.prepare(
      `SELECT storage_key FROM run_sources
        WHERE run_id = (SELECT id FROM runs WHERE view_id = ?)`
    )
      .bind(run.viewId)
      .all<{ storage_key: string }>()
    expect(
      keys.results.every(({ storage_key }) =>
        storage_key.startsWith("runs/custom/")
      )
    ).toBe(true)
  })

  it("stops compact PDFs whose combined pages exceed the run budget", async () => {
    const form = new FormData()
    form.set("emailBody", "Please quote the compact attached list.")
    const pagesPerFile = Math.floor(MAX_OCR_PAGES_PER_RUN / 2) + 1
    form.append("files", compactManyPagePdf("many-pages-a.pdf", pagesPerFile))
    form.append("files", compactManyPagePdf("many-pages-b.pdf", pagesPerFile))

    const { status, body } = await submitCustomRun(form)
    expect(status).toBe(201)

    const run = body.run!
    const step = await waitForStep(run.viewId, "read-documents", [
      "error",
      "complete",
    ])
    expect(step.status).toBe("error")
    expect(step.summary).toContain(`at most ${MAX_OCR_PAGES_PER_RUN}`)
    expect(step.summary).toMatch(/remove or split/i)

    const evidence = await readEvidence(run.viewId)
    expect(evidence.state).toBe("error")
    expect(evidence.message).toBe(step.summary)

    const pages = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM run_source_pages
        WHERE run_id = (SELECT id FROM runs WHERE view_id = ?)`
    )
      .bind(run.viewId)
      .first<{ total: number }>()
    expect(pages?.total).toBe(0)
  })

  it("rejects an unsupported media type before a run is created", async () => {
    const before = await runCount()

    const form = new FormData()
    form.set("emailBody", "Quote attached")
    form.append(
      "files",
      new File(["PK"], "list.zip", { type: "application/zip" })
    )

    const { status, body } = await submitCustomRun(form)

    expect(status).toBe(400)
    expect(body.error).toContain("not a supported file type")
    expect(await runCount()).toBe(before)
  })

  it("rejects a file whose contents do not match its declared type", async () => {
    const before = await runCount()

    const form = new FormData()
    form.set("emailBody", "Quote attached")
    form.append(
      "files",
      new File(["not really a pdf"], "list.pdf", { type: "application/pdf" })
    )

    const { status, body } = await submitCustomRun(form)

    expect(status).toBe(400)
    expect(body.error).toContain("does not contain valid")
    expect(await runCount()).toBe(before)
  })

  it("rejects a combined upload above 10 MB before a run is created", async () => {
    const before = await runCount()

    const oversized = new Uint8Array(6 * 1024 * 1024)
    oversized.set([0x25, 0x50, 0x44, 0x46], 0)

    const form = new FormData()
    form.set("emailBody", "Two large attachments")
    form.append(
      "files",
      new File([oversized], "a.pdf", { type: "application/pdf" })
    )
    form.append(
      "files",
      new File([oversized], "b.pdf", { type: "application/pdf" })
    )

    const { status, body } = await submitCustomRun(form)

    expect(status).toBe(400)
    expect(body.error).toContain("10 MB")
    expect(await runCount()).toBe(before)
  })

  it("requires an email body", async () => {
    const form = new FormData()
    form.set("emailBody", "   ")

    const { status, body } = await submitCustomRun(form)

    expect(status).toBe(400)
    expect(body.error).toContain("email body is required")
  })
})

describe("a terminal provider failure", () => {
  it("stops the graph with an explained error instead of loading forever", async () => {
    const form = new FormData()
    form.set("emailBody", "This request will not be readable.")
    form.append("files", pdfFile("trigger-provider-error.pdf", ["ANYTHING"]))

    const { status, body } = await submitCustomRun(form)
    expect(status).toBe(201)

    const run = body.run!
    const step = await waitForStep(run.viewId, "read-documents", [
      "error",
      "complete",
    ])

    expect(step.status).toBe("error")
    expect(step.summary).toContain("document reader")
    expect(step.completedAt).not.toBeNull()

    const view = await exports.default.fetch(`${base}/api/runs/${run.viewId}`)
    const { run: stopped } = await view.json<{ run: Run }>()

    expect(stopped.status).toBe("error")
    expect(stopped.workflowState).toBe("failed")
    expect(
      stopped.steps.filter((entry) => entry.status === "active")
    ).toHaveLength(0)

    const evidence = await readEvidence(run.viewId)
    expect(evidence.state).toBe("error")
    expect(evidence.message).toContain("document reader")
    // A sanitized explanation only: no key, header, or endpoint.
    expect(JSON.stringify(evidence)).not.toContain("Bearer")
    expect(JSON.stringify(evidence)).not.toContain("api.mistral.ai")
  })

  it("ends in a terminal error when the provider cannot even be selected", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "read-documents", ["complete"])

    const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
      .bind(run.viewId)
      .first<{ id: string }>()

    // A misconfigured provider throws after the step is already active. The
    // step has to reach a terminal error rather than stay active forever.
    const outcome = await readDocuments(
      envWith({ OCR_PROVIDER: "contract-fake", APP_ENV: "production" }),
      row!.id
    )

    expect(outcome.state).toBe("error")

    const step = await env.DB.prepare(
      `SELECT status, completed_at FROM run_steps
        WHERE run_id = ? AND step_key = 'read-documents'`
    )
      .bind(row!.id)
      .first<{ status: string; completed_at: string | null }>()

    expect(step!.status).toBe("error")
    expect(step!.completed_at).not.toBeNull()

    const stopped = await env.DB.prepare(
      `SELECT status, workflow_state FROM runs WHERE id = ?`
    )
      .bind(row!.id)
      .first<{ status: string; workflow_state: string }>()

    expect(stopped).toEqual({ status: "error", workflow_state: "failed" })
  })
})

describe("selecting the OCR provider", () => {
  it("refuses to build the contract fake in production", () => {
    expect(() =>
      selectOcrProvider(
        envWith({ OCR_PROVIDER: "contract-fake", APP_ENV: "production" })
      )
    ).toThrow(/not allowed in production/)
  })

  it("builds the contract fake outside production", () => {
    const provider = selectOcrProvider(
      envWith({ OCR_PROVIDER: "contract-fake", APP_ENV: "test" })
    )

    expect(provider.name).toBe("contract-fake")
  })

  it("uses Mistral's zero-based page selector with one bounded probe page", () => {
    expect(mistralPageProbe(MAX_OCR_PAGES_PER_RUN)).toBe(
      `0-${MAX_OCR_PAGES_PER_RUN}`
    )
  })

  it("rejects Mistral's probe page even when usage under-reports it", async () => {
    const requestBodies: unknown[] = []
    const requestFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body")
      }
      requestBodies.push(JSON.parse(init.body) as unknown)
      return Promise.resolve(
        Response.json({
          model: "mistral-ocr-test",
          pages: Array.from(
            { length: MAX_OCR_PAGES_PER_RUN + 1 },
            (_, index) => ({ index, markdown: `page ${index + 1}` })
          ),
          // Deliberately malformed: the returned probe page must remain the
          // hard cap even if provider usage metadata claims less work.
          usage_info: { pages_processed: 1, doc_size_bytes: 4 },
        })
      )
    }) as typeof fetch
    const provider = createMistralOcrProvider(
      envWith({ MISTRAL_API_KEY: "test-key" }),
      requestFetch
    )

    await expect(
      provider.read({
        sourceId: "source-id",
        label: "many-pages.pdf",
        mediaType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF").buffer,
        maxPages: MAX_OCR_PAGES_PER_RUN,
        runPageLimit: MAX_OCR_PAGES_PER_RUN,
      })
    ).rejects.toBeInstanceOf(OcrPageLimitError)
    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]).toMatchObject({
      pages: `0-${MAX_OCR_PAGES_PER_RUN}`,
      include_image_base64: false,
      include_blocks: false,
    })
  })

  it("reports an unknown cost rather than zero when the page price is misconfigured", () => {
    expect(estimateOcrCostUsd(env, 2)).toBeGreaterThan(0)
    expect(
      estimateOcrCostUsd(envWith({ OCR_COST_PER_1000_PAGES_USD: "" }), 2)
    ).toBeNull()
    expect(
      estimateOcrCostUsd(envWith({ OCR_COST_PER_1000_PAGES_USD: "free" }), 2)
    ).toBeNull()
    expect(
      estimateOcrCostUsd(envWith({ OCR_COST_PER_1000_PAGES_USD: "-1" }), 2)
    ).toBeNull()
  })
})

describe("resetting a run", () => {
  it("removes the stored originals as well as the records", async () => {
    const { run, ownerCapability } = await createCuratedRun()
    await waitForStep(run.viewId, "read-documents", ["complete"])

    const keys = await env.DB.prepare(
      `SELECT storage_key FROM run_sources
        WHERE run_id = (SELECT id FROM runs WHERE view_id = ?)`
    )
      .bind(run.viewId)
      .all<{ storage_key: string }>()

    expect(keys.results.length).toBe(3)

    const response = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/reset`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ownerCapability}` },
      }
    )
    expect(response.status).toBe(200)

    for (const key of keys.results) {
      expect(await env.ARTIFACTS.get(key.storage_key)).toBeNull()
    }

    const remaining = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM run_sources WHERE run_id NOT IN (SELECT id FROM runs)) AS sources,
         (SELECT COUNT(*) FROM run_source_pages WHERE run_id NOT IN (SELECT id FROM runs)) AS pages,
         (SELECT COUNT(*) FROM run_step_evidence WHERE run_id NOT IN (SELECT id FROM runs)) AS evidence`
    ).first<{ sources: number; pages: number; evidence: number }>()

    expect(remaining).toEqual({ sources: 0, pages: 0, evidence: 0 })
  })
})

describe("storing source artifacts", () => {
  const prepared: PreparedSource[] = [
    {
      kind: "email_body",
      label: "Email body",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("Please quote").buffer,
    },
    {
      kind: "inline_image",
      label: "photo.png",
      mediaType: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
    },
  ]

  it("deletes earlier R2 writes when a later write fails", async () => {
    const failure = new Error("second put failed")
    const objects = new Set<string>()
    let puts = 0
    const artifacts = {
      put(key: string) {
        puts += 1
        if (puts === 2) return Promise.reject(failure)
        objects.add(key)
        return Promise.resolve()
      },
      delete(key: string) {
        objects.delete(key)
        return Promise.resolve()
      },
    } as unknown as R2Bucket
    const database = {
      batch() {
        throw new Error("D1 must not be reached")
      },
    } as unknown as D1Database

    await expect(
      storeSources(
        { ...env, ARTIFACTS: artifacts, DB: database },
        "run-id",
        prepared,
        new Date().toISOString(),
        "custom"
      )
    ).rejects.toBe(failure)
    expect(objects.size).toBe(0)
  })

  it("deletes every R2 write and preserves a D1 batch failure", async () => {
    const failure = new Error("metadata batch failed")
    const objects = new Set<string>()
    const artifacts = {
      put(key: string) {
        objects.add(key)
        return Promise.resolve()
      },
      delete(key: string) {
        objects.delete(key)
        return Promise.resolve()
      },
    } as unknown as R2Bucket
    const statement = { bind: () => statement }
    const database = {
      prepare: () => statement,
      batch: () => Promise.reject(failure),
    } as unknown as D1Database

    await expect(
      storeSources(
        { ...env, ARTIFACTS: artifacts, DB: database },
        "run-id",
        prepared,
        new Date().toISOString(),
        "curated"
      )
    ).rejects.toBe(failure)
    expect(objects.size).toBe(0)
  })
})

async function runCount(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM runs`).first<{
    total: number
  }>()

  return row?.total ?? 0
}
