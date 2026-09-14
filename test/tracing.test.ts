import { z } from "zod"
import { extractionPrompt } from "../worker/langfuse/extraction-prompt"
import { bundledPrompt } from "../worker/langfuse/fallbacks"
import { rerankPrompt } from "../worker/langfuse/rerank-prompt"
import { createOpenRouterExtractionProvider } from "../worker/providers/openrouter-extraction"
import { createOpenRouterRerankProvider } from "../worker/providers/openrouter-rerank"
import { env } from "cloudflare:workers"
import { LangfuseSpanProcessor } from "@langfuse/otel"
import {
  createTraceId,
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing"
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk"
import { getPropagatedAttributesFromContext } from "@langfuse/core"
import { context, trace } from "@opentelemetry/api"
import type { Context } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import type { Span } from "@opentelemetry/sdk-trace-base"
import { generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { readConfig } from "../worker/env"
import { AsyncLocalStorageContextManager } from "../worker/langfuse/context-manager"
import {
  createObservationId,
  langfuseIdGenerator,
  MATCH_LINE_OBSERVATION_NAME,
  withObservationId,
} from "../worker/langfuse/ids"
import {
  RUN_TRACE_NAME,
  MASKED_EMAIL,
  MASKED_PHONE,
  contactMaskingSpanProcessor,
  loadRunTraceContext,
  maskContactDetails,
  traceRunStep,
  type RunTraceContext,
} from "../worker/langfuse/tracing"

/**
 * What a run's trace looks like, without a Langfuse project.
 *
 * The suite installs an in-memory OpenTelemetry provider in place of the
 * Langfuse exporter and reads the finished spans back. That proves the parts
 * the Workers runtime has to get right — the context manager carries the
 * active step across `await`, the AI SDK's generation nests under the step,
 * and every step of a run joins one deterministic trace — without a network.
 */

/**
 * The Langfuse processor copies the attributes `propagateAttributes` put in
 * the context onto every span it starts. This stand-in does the same, so the
 * trace name, tags, and metadata a step propagates can be read back here.
 */
class PropagatingSpanProcessor extends SimpleSpanProcessor {
  override onStart(span: Span, parentContext: Context): void {
    span.setAttributes(getPropagatedAttributesFromContext(parentContext))
    super.onStart(span, parentContext)
  }
}

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({
  idGenerator: langfuseIdGenerator,
  spanProcessors: [new PropagatingSpanProcessor(exporter)],
})

context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)
afterAll(async () => {
  await provider.shutdown()
})

beforeEach(() => {
  exporter.reset()
})

const RUN: RunTraceContext = {
  runId: "run-tracing-1",
  viewId: "view-tracing-1",
  userId: "user-tracing-1",
  sourceKind: "curated",
  scenarioId: "cable-order",
  sources: [{ label: "order.pdf", mediaType: "application/pdf", byteSize: 10 }],
}

const SEEDED_AT = "2026-01-01T00:00:00.000Z"

/** A run row with an explicit stored owner hash for identity propagation. */
async function seedTraceRun(ownerCapabilityHash: string) {
  const runId = crypto.randomUUID()
  const viewId = crypto.randomUUID()

  await env.DB.prepare(
    `INSERT INTO runs (
       id, view_id, owner_capability_hash, source_kind, scenario_id,
       status, workflow_instance_id, workflow_state, workspace_hash,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'curated', 'cable-order',
               'active', NULL, 'pending', NULL, ?, ?)`
  )
    .bind(runId, viewId, ownerCapabilityHash, SEEDED_AT, SEEDED_AT)
    .run()

  const run = await loadRunTraceContext(env, runId)
  if (run === null) throw new Error(`Trace context missing for run ${runId}`)

  return run
}

/** The isolate's own bindings with variables overridden, as in every suite. */
function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides }
}

function mockModel(outputText = "hello") {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: outputText }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: 3,
          noCache: 3,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
      warnings: [],
    },
  })
}

it("links the fetched extraction version on the actual provider generation", async () => {
  const prompt = bundledPrompt("rfq/extract")
  prompt.version = 41
  prompt.isFallback = false
  const selected = extractionPrompt(prompt)
  const requests: z.infer<ReturnType<typeof z.json>>[] = []
  const client = createOpenRouterExtractionProvider(
    readConfig(envWith({ OPENROUTER_API_KEY: "offline-test" })),
    (_url, init) => {
      requests.push(z.json().parse(JSON.parse(z.string().parse(init?.body))))
      return Promise.resolve(
        Response.json({
          id: "generation-probe",
          model: selected.config.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "{}" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      )
    }
  )
  await traceRunStep(env, RUN, { name: "structure-rfq" }, async () => {
    await client.extract({
      runId: RUN.runId,
      prompt: selected,
      documents: [
        {
          label: "email",
          kind: "email_body",
          pageNumber: 1,
          markdown: "Please quote belts",
        },
      ],
      schemaName: "rfq_extraction",
      schemaDescription: "RFQ facts",
    })
    return { state: "complete" }
  })
  const sent = z
    .object({
      model: z.string(),
      temperature: z.number(),
      response_format: z.object({
        json_schema: z.object({ schema: z.record(z.string(), z.json()) }),
      }),
    })
    .parse(requests[0])
  expect(sent.model).toBe(selected.config.model)
  expect(sent.temperature).toBe(selected.config.temperature)
  expect(sent.response_format.json_schema.schema).toEqual(
    selected.config.response_format
  )
  const generation = exporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.attributes["langfuse.observation.prompt.name"] === "rfq/extract"
    )
  expect(generation?.attributes["langfuse.observation.prompt.version"]).toBe(41)
})

it("marks a bundled fallback generation, which carries no prompt link", async () => {
  const selected = extractionPrompt(bundledPrompt("rfq/extract"))
  expect(selected.prompt.isFallback).toBe(true)
  const client = createOpenRouterExtractionProvider(
    readConfig(envWith({ OPENROUTER_API_KEY: "offline-test" })),
    () =>
      Promise.resolve(
        Response.json({
          id: "fallback-generation-probe",
          model: selected.config.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "{}" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      )
  )
  await traceRunStep(env, RUN, { name: "structure-rfq" }, async () => {
    await client.extract({
      runId: RUN.runId,
      prompt: selected,
      documents: [
        {
          label: "email",
          kind: "email_body",
          pageNumber: 1,
          markdown: "Please quote belts",
        },
      ],
      schemaName: "rfq_extraction",
      schemaDescription: "RFQ facts",
    })
    return { state: "complete" }
  })
  const generation = exporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.attributes["langfuse.observation.metadata.promptSource"] ===
        "bundled"
    )
  expect(generation).toBeDefined()
  expect(
    generation?.attributes["langfuse.observation.prompt.name"]
  ).toBeUndefined()
})

it("links the fetched rerank version and forwards its full schema", async () => {
  const prompt = bundledPrompt("rfq/rerank")
  prompt.version = 43
  prompt.isFallback = false
  const selected = rerankPrompt(prompt)
  const requests: z.infer<ReturnType<typeof z.json>>[] = []
  const client = createOpenRouterRerankProvider(
    readConfig(envWith({ OPENROUTER_API_KEY: "offline-test" })),
    (_url, init) => {
      requests.push(z.json().parse(JSON.parse(z.string().parse(init?.body))))
      return Promise.resolve(
        Response.json({
          id: "rerank-generation-probe",
          model: selected.config.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  ranked: [{ sku: "NX-VLV-2210", score: 0.9, reason: "DN25." }],
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      )
    }
  )
  await traceRunStep(env, RUN, { name: "match-products" }, async () => {
    await client.rerank({
      runId: RUN.runId,
      prompt: selected,
      reference: "DN25 ball valve",
      description: "Brass ball valve DN25",
      candidates: [
        {
          sku: "NX-VLV-2210",
          name: "Brass ball valve",
          description: "DN25 lever-operated brass ball valve",
          category: "Valves",
          manufacturer: "Nordex",
          unit: "piece",
          knownAs: ["ball valve"],
        },
      ],
      schemaName: "catalog_rerank",
      schemaDescription: "Candidate products ranked best first.",
    })
    return { state: "complete" }
  })
  const sent = z
    .object({
      model: z.string(),
      temperature: z.number(),
      response_format: z.object({
        json_schema: z.object({ schema: z.record(z.string(), z.json()) }),
      }),
    })
    .parse(requests[0])
  expect(sent.model).toBe(selected.config.model)
  expect(sent.temperature).toBe(selected.config.temperature)
  expect(sent.response_format.json_schema.schema).toEqual(
    selected.config.response_format
  )
  const generation = exporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.attributes["langfuse.observation.prompt.name"] === "rfq/rerank"
    )
  expect(generation?.attributes["langfuse.observation.prompt.version"]).toBe(43)
})

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
async function traceExtractionCost(reportedCostUsd: number | null) {
  const prompt = extractionPrompt(bundledPrompt("rfq/extract"))
  const usage =
    reportedCostUsd === null
      ? { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      : {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          cost: reportedCostUsd,
        }

  const provider = createOpenRouterExtractionProvider(
    readConfig(envWith({ OPENROUTER_API_KEY: "offline-test" })),
    () =>
      Promise.resolve(
        Response.json({
          id: "generation-cost-probe",
          model: prompt.config.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "{}" },
              finish_reason: "stop",
            },
          ],
          usage,
        })
      )
  )

  await traceRunStep(env, RUN, { name: "structure-rfq" }, async () => {
    await provider.extract({
      runId: RUN.runId,
      prompt,
      documents: [
        {
          label: "email",
          kind: "email_body",
          pageNumber: 1,
          markdown: "Please quote belts",
        },
      ],
      schemaName: "rfq_extraction",
      schemaDescription: "RFQ facts",
    })
    return { state: "complete" }
  })

  return exporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.attributes["gen_ai.response.id"] === "generation-cost-probe"
    )
}

it("attaches OpenRouter's extraction cost to the actual AI SDK generation", async () => {
  const generation = await traceExtractionCost(0.000123456789)

  expect(generation?.attributes["langfuse.observation.cost_details"]).toBe(
    JSON.stringify({ total: 0.000123456789 })
  )
})

it("leaves extraction cost absent when OpenRouter reports none", async () => {
  const generation = await traceExtractionCost(null)

  expect(generation?.attributes).not.toHaveProperty(
    "langfuse.observation.cost_details"
  )
})

it("preserves a zero OpenRouter rerank cost on the actual generation", async () => {
  const provider = createOpenRouterRerankProvider(
    readConfig(envWith({ OPENROUTER_API_KEY: "offline-test" })),
    () =>
      Promise.resolve(
        Response.json({
          id: "rerank-cost-probe",
          model: "openai/gpt-5.6-luna",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"ok":true}' },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
            cost: 0,
          },
        })
      )
  )

  await traceRunStep(env, RUN, { name: "match-products" }, async () => {
    await provider.rerank({
      runId: RUN.runId,
      prompt: rerankPrompt(bundledPrompt("rfq/rerank")),
      reference: "NX-FLT-1120",
      description: "Filter cartridge",
      candidates: [],
      schemaName: "rerank_probe",
      schemaDescription: "A telemetry probe",
    })
    return { state: "complete" }
  })

  const generation = exporter
    .getFinishedSpans()
    .find(
      (span) => span.attributes["gen_ai.response.id"] === "rerank-cost-probe"
    )
  expect(generation?.attributes["langfuse.observation.cost_details"]).toBe(
    JSON.stringify({ total: 0 })
  )
})

it("records OCR pages without attaching application cost", async () => {
  await traceRunStep(env, RUN, { name: "read-documents" }, () =>
    startActiveObservation(
      "read-document",
      (generation) => {
        generation.update({
          model: "mistral-ocr-latest",
          usageDetails: { pages: 2 },
        })
        return Promise.resolve({ state: "complete" })
      },
      { asType: "generation" }
    )
  )

  const generation = exporter
    .getFinishedSpans()
    .find((span) => span.name === "read-document")
  expect(generation?.attributes["langfuse.observation.usage_details"]).toBe(
    JSON.stringify({ pages: 2 })
  )
  expect(generation?.attributes).not.toHaveProperty(
    "langfuse.observation.cost_details"
  )
})

describe("tracing configuration", () => {
  it("is off until every Langfuse value is present", () => {
    expect(readConfig(env).tracing).toEqual({
      provider: "none",
      reason: "unconfigured",
    })

    expect(
      readConfig(
        envWith({
          LANGFUSE_PUBLIC_KEY: "pk-lf-test",
          LANGFUSE_SECRET_KEY: "sk-lf-test",
        })
      ).tracing
    ).toEqual({ provider: "none", reason: "unconfigured" })
  })

  it("resolves a Langfuse target with a normalised base URL", () => {
    expect(
      readConfig(
        envWith({
          LANGFUSE_PUBLIC_KEY: "pk-lf-test",
          LANGFUSE_SECRET_KEY: "sk-lf-test",
          LANGFUSE_BASE_URL: "https://cloud.langfuse.com/",
        })
      ).tracing
    ).toEqual({
      provider: "langfuse",
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: "https://cloud.langfuse.com",
    })
  })
})

describe("traceRunStep", () => {
  it("puts every step of a run in one trace derived from the run id", async () => {
    await traceRunStep(env, RUN, { name: "read-documents" }, () =>
      Promise.resolve({ state: "complete", pageCount: 2 })
    )
    await traceRunStep(
      env,
      RUN,
      { name: "retrieve-candidates", asType: "retriever" },
      () => Promise.resolve({ state: "complete" })
    )

    const spans = exporter.getFinishedSpans()
    const traceId = await createTraceId(RUN.runId)

    expect(spans.map((span) => span.name)).toEqual([
      "read-documents",
      "retrieve-candidates",
    ])
    expect(spans.every((span) => span.spanContext().traceId === traceId)).toBe(
      true
    )
    expect(
      spans.every(
        (span) => span.parentSpanContext?.spanId === "0000000000000001"
      )
    ).toBe(true)
  })

  it("names the trace, tags the run kind, and records the outcome as output", async () => {
    await traceRunStep(
      env,
      RUN,
      { name: "build-estimate", input: { reviewed: false } },
      () => Promise.resolve({ state: "complete", lineCount: 3 })
    )

    const [span] = exporter.getFinishedSpans()

    expect(span?.attributes["langfuse.trace.name"]).toBe(RUN_TRACE_NAME)
    expect(span?.attributes["session.id"]).toBe(RUN.viewId)
    expect(span?.attributes["user.id"]).toBe(RUN.userId)
    expect(span?.attributes["langfuse.trace.tags"]).toEqual(["curated"])
    expect(span?.attributes["langfuse.trace.metadata.runId"]).toBe(RUN.runId)
    expect(span?.attributes["langfuse.trace.metadata.scenarioId"]).toBe(
      "cable-order"
    )
    expect(span?.attributes["langfuse.observation.input"]).toBe(
      JSON.stringify({ reviewed: false })
    )
    expect(span?.attributes["langfuse.observation.output"]).toBe(
      JSON.stringify({ state: "complete", lineCount: 3 })
    )
    expect(span?.attributes["langfuse.observation.type"]).toBe("span")
  })

  it("groups stored owner hashes under salted user identifiers", async () => {
    const first = await seedTraceRun("shared-owner-capability-hash")
    const second = await seedTraceRun("shared-owner-capability-hash")
    const other = await seedTraceRun("other-owner-capability-hash")

    await traceRunStep(env, first, { name: "read-first" }, () =>
      Promise.resolve({ state: "complete" })
    )
    await traceRunStep(env, second, { name: "read-second" }, () =>
      Promise.resolve({ state: "complete" })
    )
    await traceRunStep(env, other, { name: "read-other" }, () =>
      Promise.resolve({ state: "complete" })
    )

    const spans = exporter.getFinishedSpans()
    const identities = spans.map((span) => ({
      sessionId: span.attributes["session.id"],
      userId: span.attributes["user.id"],
    }))

    expect(identities).toEqual([
      { sessionId: first.viewId, userId: first.userId },
      { sessionId: second.viewId, userId: second.userId },
      { sessionId: other.viewId, userId: other.userId },
    ])
    expect(first.userId).toBe(second.userId)
    expect(first.userId).not.toBe(other.userId)
    expect(first.userId).not.toContain("shared-owner-capability-hash")
    expect(first.userId).toBe(
      await sha256Hex(
        "test-rate-limit-salt:langfuse-user:shared-owner-capability-hash"
      )
    )
  })

  it("marks a failed step at the error level with its message", async () => {
    await traceRunStep(env, RUN, { name: "structure-rfq" }, () =>
      Promise.resolve({
        state: "error",
        message: "The extraction model rejected the request (429).",
      })
    )

    const [span] = exporter.getFinishedSpans()

    expect(span?.attributes["langfuse.observation.level"]).toBe("ERROR")
    expect(span?.attributes["langfuse.observation.status_message"]).toBe(
      "The extraction model rejected the request (429)."
    )
  })

  it("nests a model call and a manual observation under the step", async () => {
    await traceRunStep(env, RUN, { name: "match-products" }, async () => {
      const child = startObservation("match-line", { input: { position: 1 } })
      await generateText({
        model: mockModel(),
        prompt: "rank",
        telemetry: {
          functionId: "rerank-candidates",
          integrations: new LangfuseVercelAiSdkIntegration(),
        },
      })
      child.end()

      return { state: "complete" }
    })

    const spans = exporter.getFinishedSpans()
    const step = spans.find((span) => span.name === "match-products")
    const ids = new Set(spans.map((span) => span.spanContext().spanId))
    const stepId = step?.spanContext().spanId

    expect(stepId).toBeDefined()
    expect(spans.length).toBeGreaterThan(2)

    for (const span of spans) {
      if (span === step) continue
      // Every other span hangs off the step, directly or through a sibling.
      expect(ids.has(span.parentSpanContext?.spanId ?? "")).toBe(true)
      expect(span.spanContext().traceId).toBe(step?.spanContext().traceId)
    }

    const generation = spans.find((span) =>
      Object.keys(span.attributes).some((key) => key.startsWith("gen_ai."))
    )
    expect(generation).toBeDefined()
  })

  it("gives each match-line a stable id without reusing it for nested spans", async () => {
    const first = await createObservationId(
      RUN.runId,
      MATCH_LINE_OBSERVATION_NAME,
      1
    )
    const repeated = await createObservationId(
      RUN.runId,
      MATCH_LINE_OBSERVATION_NAME,
      1
    )
    const second = await createObservationId(
      RUN.runId,
      MATCH_LINE_OBSERVATION_NAME,
      2
    )

    expect(repeated).toBe(first)
    expect(second).not.toBe(first)

    await traceRunStep(env, RUN, { name: "match-products" }, () =>
      withObservationId(RUN.runId, MATCH_LINE_OBSERVATION_NAME, 1, () =>
        startActiveObservation(MATCH_LINE_OBSERVATION_NAME, async () => {
          await generateText({
            model: mockModel(),
            prompt: "rank",
            telemetry: {
              functionId: "rerank-candidates",
              integrations: new LangfuseVercelAiSdkIntegration(),
            },
          })
          return { state: "complete" }
        })
      )
    )

    const spans = exporter.getFinishedSpans()
    const line = spans.find((span) => span.name === MATCH_LINE_OBSERVATION_NAME)
    const generation = spans.find((span) =>
      Object.keys(span.attributes).some((key) => key.startsWith("gen_ai."))
    )

    expect(line?.spanContext().spanId).toBe(first)
    expect(generation?.spanContext().spanId).not.toBe(first)
  })

  it("runs the step untraced when the run row is unknown", async () => {
    const result = await traceRunStep(
      env,
      null,
      { name: "deliver-quote" },
      () => Promise.resolve({ state: "delivered" })
    )

    expect(result).toEqual({ state: "delivered" })
    expect(exporter.getFinishedSpans()).toEqual([])
  })
})

describe("contact masking", () => {
  it("uses the Langfuse processor export path for nested trace data", async () => {
    const maskedExporter = new InMemorySpanExporter()
    const maskingProcessor = new LangfuseSpanProcessor({
      exporter: maskedExporter,
      exportMode: "immediate",
      mask: maskContactDetails,
      mediaUploadEnabled: false,
      shouldExportSpan: () => true,
    })
    const maskingProvider = new BasicTracerProvider({
      spanProcessors: [contactMaskingSpanProcessor(), maskingProcessor],
    })
    const maskingTracer = maskingProvider.getTracer("contact-masking-test")
    const span = maskingTracer.startSpan("mask-contact-details")

    const uuid = "550e8400-e29b-41d4-a716-446655440000"
    const sku = "SKU-123-456-7890"
    const amount = "EUR 1,234.56"
    const contacts = [
      "buyer@northwind.example",
      "ops@northwind.example",
      "+49 30 5550 118",
      "+493012345678",
      "+49 (30) 12345678",
      "(030) 5550 119",
      "202-555-0100",
      "030 12345678",
      "030/12345678",
      "0049 30 12345678",
      "555 123 4567",
      "555.123.4567",
    ]
    // Order data that shares digits and separators with phone numbers.
    const orderData = [
      "NX-FLT-1120",
      "OLD ITEM NR 45-221-B",
      "2026-08-03T07:42:00Z",
      "03.08.2026",
      "16 pleeted panel filter 592x592",
      "20260813",
      "6205-2",
      "SPA1250",
      "DN50",
    ]
    // Known gap: a bare digit run cannot be told apart from an order number.
    const bareDigits = "5551234567"
    const multiplySerializedContacts = JSON.stringify(
      JSON.stringify({
        email: "next\nbuyer@northwind.example",
        phone: "next\n+49 30 5550 118",
      })
    )

    span.setAttribute(
      "langfuse.observation.input",
      JSON.stringify({
        contacts: [
          {
            email: "buyer@northwind.example",
            phone: "+49 30 5550 118",
          },
          { phone: "+493012345678" },
          { phone: "+49 (30) 12345678" },
        ],
        uuid,
        sku,
        amount,
        localContacts: contacts.slice(7),
        orderData,
        bareDigits,
      })
    )
    span.setAttribute(
      "langfuse.observation.output",
      JSON.stringify({
        reply: "Call (030) 5550 119 or 202-555-0100.",
        contactName: "Lena Vogt",
      })
    )
    span.setAttribute(
      "langfuse.observation.metadata",
      JSON.stringify({
        attributes: JSON.stringify({ email: "ops@northwind.example" }),
      })
    )
    span.setAttribute(
      "langfuse.observation.metadata.contact",
      "ops@northwind.example"
    )
    span.setAttribute(
      "gen_ai.tool.call.arguments",
      JSON.stringify({ contact: "buyer@northwind.example" })
    )
    span.setAttribute("gen_ai.input.messages", multiplySerializedContacts)
    span.setAttribute(
      "gen_ai.tool.call.result",
      JSON.stringify({ phone: "+493012345678" })
    )
    span.end()

    await generateText({
      model: mockModel(
        "Email buyer@northwind.example or call +49 (30) 12345678."
      ),
      system: "Send questions to ops@northwind.example.",
      prompt: "Call +49 30 5550 118 about the request.",
      telemetry: {
        functionId: "contact-masking-test",
        integrations: new LangfuseVercelAiSdkIntegration({
          tracer: maskingTracer,
        }),
      },
    })

    await maskingProcessor.forceFlush()

    const exported = maskedExporter.getFinishedSpans()
    const attributeNames = new Set(
      exported.flatMap((finished) => Object.keys(finished.attributes))
    )
    const attributes = JSON.stringify(
      exported.map((finished) => finished.attributes)
    )
    const maskedNestedInput = exported.find(
      (finished) => finished.name === "mask-contact-details"
    )?.attributes["gen_ai.input.messages"]

    expect(attributeNames).toContain("gen_ai.system_instructions")
    expect(attributeNames).toContain("gen_ai.input.messages")
    expect(attributeNames).toContain("gen_ai.output.messages")
    expect(attributeNames).toContain("gen_ai.tool.call.arguments")
    expect(attributeNames).toContain("gen_ai.tool.call.result")
    expect(attributes).toContain(MASKED_EMAIL)
    expect(attributes).toContain(MASKED_PHONE)
    for (const contact of contacts) expect(attributes).not.toContain(contact)
    for (const value of orderData) expect(attributes).toContain(value)
    expect(attributes).toContain(bareDigits)
    expect(attributes).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)
    // Independent of PHONE_PATTERN: catch international numbers even when a
    // serialized escape leaves a word character immediately before the plus.
    expect(attributes).not.toMatch(/\+\d(?:[\d ().-]*\d){6,}/)
    expect(attributes).not.toMatch(
      /(?<![\w-])(?:\+\d{8,15}|\+\d{1,3}[ .-]?(?:\(\d{2,5}\)|\d{2,5})(?:[ .-]?\d{2,8}){1,4}|\(\d{2,4}\)[ .-]\d{3,4}(?:[ .-]\d{2,4}){1,2}|\d{3}-\d{3}-\d{4})(?![\w-])/
    )
    const firstParsedLayer: unknown = JSON.parse(
      z.string().parse(maskedNestedInput)
    )
    const secondParsedLayer: unknown = JSON.parse(
      z.string().parse(firstParsedLayer)
    )
    expect(secondParsedLayer).toEqual({
      email: `next\n${MASKED_EMAIL}`,
      phone: `next\n${MASKED_PHONE}`,
    })
    expect(attributes).toContain(uuid)
    expect(attributes).toContain(sku)
    expect(attributes).toContain(amount)
    expect(attributes).toContain("Lena Vogt")

    await maskingProvider.shutdown()
  })
})
