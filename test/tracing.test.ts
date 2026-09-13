import { env } from "cloudflare:workers"
import { createTraceId, startObservation } from "@langfuse/tracing"
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
  RUN_TRACE_NAME,
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
  sourceKind: "curated",
  scenarioId: "cable-order",
  sources: [{ label: "order.pdf", mediaType: "application/pdf", byteSize: 10 }],
}

/** The isolate's own bindings with variables overridden, as in every suite. */
function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides }
}

function mockModel() {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "hello" }],
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
