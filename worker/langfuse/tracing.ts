/**
 * Langfuse tracing for a run.
 *
 * One run is one Langfuse trace. Its identifier is derived from the run
 * identifier, so every workflow step, however many isolates and however much
 * hibernation lie between them, lands in the same trace. Each step is one
 * observation in that trace; the model calls a step makes nest under it
 * through the OpenTelemetry context.
 *
 * The step observations share a placeholder parent identifier. No observation
 * carries that identifier, so Langfuse treats each step as a root of the
 * trace. That is the pattern the Langfuse documentation gives for joining
 * work from separate processes, and it is what a hibernating workflow is.
 *
 * Tracing is off until all three Langfuse values are configured. With tracing
 * off, the OpenTelemetry API hands out no-op spans, so a step costs nothing and
 * the provider clients never learn whether a trace exists.
 *
 * Unlike analytics, tracing sends business content: the model input, the model
 * output, the document text, and the evidence a step writes. See the Tracing
 * section of the README before configuring it against a project other people
 * can read.
 *
 * Exports go out as each span ends, and a step waits for them before it
 * returns. A Workflow step's isolate can be evicted the moment the step
 * completes, so anything still buffered then would be lost.
 */

import { LangfuseSpanProcessor } from "@langfuse/otel"
import {
  createTraceId,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing"
import { context, trace } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { registerTelemetry } from "ai"
import { z } from "zod"

import { readConfig } from "../env"
import type { LangfuseTarget } from "./target"
import { loadSources } from "../sources"
import { privateValueHash } from "../rate-limit"

import { AsyncLocalStorageContextManager } from "./context-manager"
import { langfuseIdGenerator } from "./ids"
import { LangfuseOpenRouterIntegration } from "./openrouter-cost-telemetry"

/**
 * The AI SDK reports every model call to the registered integration, which
 * turns it into a Langfuse generation. Registered once per isolate; with no
 * tracer provider installed, the generation is a no-op span.
 */
registerTelemetry(new LangfuseOpenRouterIntegration())

/** The name every step of a run traces under. Stable, so it can be filtered. */
export const RUN_TRACE_NAME = "process-rfq"

/**
 * The parent identifier every step observation claims. Nothing is exported
 * with this identifier, so Langfuse shows each step at the top of the trace.
 * It is the placeholder the Langfuse documentation itself uses.
 */
const STEP_PARENT_SPAN_ID = "0000000000000001"

/** One source as the trace names it: what it is, never what it contains. */
export type TracedSource = {
  label: string
  mediaType: string
  byteSize: number
}

/**
 * What every observation of a run carries. Loaded once per workflow
 * invocation, from the run row, and handed to every step. The sources are
 * the request as it arrived, and become the input of the trace's first
 * observation.
 */
export type RunTraceContext = {
  runId: string
  viewId: string
  userId: string
  sourceKind: string
  scenarioId: string | null
  sources: TracedSource[]
}

type RunTraceRow = {
  view_id: string
  owner_capability_hash: string
  source_kind: string
  scenario_id: string | null
}

/**
 * Loads what the trace carries. A read that fails yields no context, so the
 * run proceeds untraced rather than stopping before its first durable step.
 */
export async function loadRunTraceContext(
  env: Env,
  runId: string
): Promise<RunTraceContext | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT view_id, owner_capability_hash, source_kind, scenario_id
         FROM runs WHERE id = ?`
    )
      .bind(runId)
      .first<RunTraceRow>()

    if (!row) return null

    const sources = (await loadSources(env, runId)).map((source) => ({
      label: source.label,
      mediaType: source.mediaType,
      byteSize: source.byteSize,
    }))
    const userId = await privateValueHash(
      env,
      "langfuse-user",
      row.owner_capability_hash
    )

    return {
      runId,
      viewId: row.view_id,
      userId,
      sourceKind: row.source_kind,
      scenarioId: row.scenario_id,
      sources,
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "tracing_context_unavailable",
        runId,
        message: error instanceof Error ? error.message : "unknown",
      })
    )
    return null
  }
}

/** The observation types a workflow step maps to. Model calls nest inside. */
export type StepObservationType = "span" | "retriever" | "tool"

/** What a step observation may take as input: small, named facts. */
export type StepInput = Record<
  string,
  string | number | boolean | null | TracedSource[]
>

/**
 * What a step's observation records beyond the result: an active, verb-first
 * name, the type, the input a reviewer wants at a glance, and, for a step
 * whose result carries a whole payload, the summary to record instead.
 */
export type StepTrace<T extends StepOutcome> = {
  name: string
  asType?: StepObservationType
  input?: StepInput
  output?: (result: T) => StepOutcome
}

/**
 * The outcome every traced step returns: a state, and a message when the
 * state is an error. The recorder writes the same two facts to the run.
 */
export type StepOutcome = { state: string; message?: string }

/**
 * Runs one workflow step inside its observation, then waits for the export.
 *
 * The result is the observation's output as-is. Outcomes are small, typed
 * summaries, so a reviewer reads the counts and the state in the trace list
 * without opening the evidence. An `error` state sets the observation level
 * and status message, so failed runs are one filter away.
 */
export async function traceRunStep<T extends StepOutcome>(
  env: Env,
  run: RunTraceContext | null,
  step: StepTrace<T>,
  fn: () => Promise<T>
): Promise<T> {
  const processor = installTracing(env)

  // Without a context the step runs untraced. Its model calls still start
  // spans through the global tracer, so the export is still awaited.
  if (run === null) {
    try {
      return await fn()
    } finally {
      await flushTracing(processor)
    }
  }

  const traceId = await createTraceId(run.runId)

  const observed = async (observation: StepObservation): Promise<T> => {
    if (step.input) observation.update({ input: step.input })

    const result = await fn()
    const output = step.output ? step.output(result) : result

    if (result.state === "error") {
      observation.update({
        output,
        level: "ERROR",
        statusMessage: result.message,
      })
    } else {
      observation.update({ output })
    }

    return result
  }

  const options = {
    parentSpanContext: {
      traceId,
      spanId: STEP_PARENT_SPAN_ID,
      traceFlags: 1,
    },
  }

  try {
    return await propagateAttributes(
      {
        traceName: RUN_TRACE_NAME,
        sessionId: run.viewId,
        userId: run.userId,
        tags: [run.sourceKind],
        metadata: {
          runId: run.runId,
          viewId: run.viewId,
          sourceKind: run.sourceKind,
          scenarioId: run.scenarioId ?? "",
        },
      },
      (): Promise<T> => {
        // The SDK types each observation type as its own overload, so the
        // type is chosen here rather than passed through.
        switch (step.asType) {
          case "retriever":
            return startActiveObservation(step.name, observed, {
              ...options,
              asType: "retriever",
            })
          case "tool":
            return startActiveObservation(step.name, observed, {
              ...options,
              asType: "tool",
            })
          default:
            return startActiveObservation(step.name, observed, options)
        }
      }
    )
  } finally {
    await flushTracing(processor)
  }
}

/** What a step's callback may set on its observation, whatever its type. */
type StepObservation = {
  update(attributes: {
    input?: StepInput
    output?: StepOutcome
    level?: "ERROR"
    statusMessage?: string
  }): StepObservation
}

/**
 * The installed processor for this isolate, or null with tracing off. The
 * OpenTelemetry globals can be set once per isolate, so the first configured
 * `Env` decides; a deployed isolate only ever holds one.
 */
let installed: LangfuseSpanProcessor | null = null

function installTracing(env: Env): LangfuseSpanProcessor | null {
  const target = readConfig(env).tracing
  if (target.provider === "none") return null
  if (installed) return installed

  installed = installLangfuse(target, readConfig(env).appEnv)
  return installed
}

function installLangfuse(
  target: LangfuseTarget,
  environment: string
): LangfuseSpanProcessor {
  const processor = new LangfuseSpanProcessor({
    publicKey: target.publicKey,
    secretKey: target.secretKey,
    baseUrl: target.baseUrl,
    environment,
    exportMode: "immediate",
    mask: maskContactDetails,
  })

  const provider = new BasicTracerProvider({
    idGenerator: langfuseIdGenerator,
    spanProcessors: [contactMaskingSpanProcessor(), processor],
    resource: resourceFromAttributes({ "service.name": "calm-badger" }),
  })

  context.setGlobalContextManager(new AsyncLocalStorageContextManager())
  trace.setGlobalTracerProvider(provider)

  return processor
}

/** Fixed values written in place of contact details before an export. */
export const MASKED_EMAIL = "[EMAIL_REDACTED]"
export const MASKED_PHONE = "[PHONE_REDACTED]"

const EMAIL_PATTERN =
  /(^|\\(?:n|r|t)|[^\w@.+%-])(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?![A-Z0-9-])/gi
const STRING_ATTRIBUTE_SCHEMA = z.string()

/** Content-bearing attributes emitted by the current AI SDK integration. */
const AI_SDK_CONTACT_DATA_ATTRIBUTES = new Set([
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
])

/** Langfuse-native attributes whose values can hold traced business content. */
const LANGFUSE_CONTACT_DATA_ATTRIBUTES = new Set([
  "langfuse.observation.input",
  "langfuse.trace.input",
  "langfuse.observation.output",
  "langfuse.trace.output",
  "langfuse.observation.metadata",
  "langfuse.trace.metadata",
])

const LANGFUSE_METADATA_PREFIXES = [
  "langfuse.observation.metadata.",
  "langfuse.trace.metadata.",
]

/**
 * Matches common phone numbers without treating UUIDs, SKUs, or amounts as
 * contact details. International numbers need a leading plus. Local numbers
 * need either an area-code pair of parentheses or the 3-3-4 hyphen form.
 */
const PHONE_PATTERN =
  /(^|[^\w-]|\\(?:n|r|t))(?:\+\d{8,15}|\+\d{1,3}[ .-]?(?:\(\d{2,5}\)|\d{2,5})(?:[ .-]?\d{2,8}){1,4}|\(\d{2,4}\)[ .-]\d{3,4}(?:[ .-]\d{2,4}){1,2}|\d{3}-\d{3}-\d{4})(?![\w-])/g

/**
 * Masks the stringified input, output, or metadata value supplied by the
 * Langfuse span processor. Replacing in the JSON text reaches nested values
 * and values that themselves contain JSON.
 */
export function maskContactDetails({ data }: { data: string }): string {
  return data
    .replace(
      EMAIL_PATTERN,
      (_emailWithBoundary, boundary: string) => `${boundary}${MASKED_EMAIL}`
    )
    .replace(
      PHONE_PATTERN,
      (_phoneWithBoundary, boundary: string) => `${boundary}${MASKED_PHONE}`
    )
}

function carriesContactData(attributeName: string): boolean {
  return (
    AI_SDK_CONTACT_DATA_ATTRIBUTES.has(attributeName) ||
    LANGFUSE_CONTACT_DATA_ATTRIBUTES.has(attributeName) ||
    LANGFUSE_METADATA_PREFIXES.some((prefix) =>
      attributeName.startsWith(prefix)
    )
  )
}

/**
 * Masks third-party OpenTelemetry attributes before the Langfuse processor
 * receives them. The Langfuse mask hook covers its native attributes, but the
 * AI SDK 7 integration records model content in `gen_ai.*` attributes.
 */
class ContactMaskingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes

    for (const [attributeName, attributeValue] of Object.entries(attributes)) {
      if (!carriesContactData(attributeName)) continue

      const stringValue = STRING_ATTRIBUTE_SCHEMA.safeParse(attributeValue)
      if (!stringValue.success) continue

      attributes[attributeName] = maskContactDetails({ data: stringValue.data })
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

/** A new processor instance for each OpenTelemetry provider. */
export function contactMaskingSpanProcessor(): SpanProcessor {
  return new ContactMaskingSpanProcessor()
}

/**
 * Waits for every ended span to leave the isolate. A Langfuse outage must not
 * fail a run, so the failure is logged and swallowed here.
 */
async function flushTracing(
  processor: LangfuseSpanProcessor | null
): Promise<void> {
  if (!processor) return

  try {
    await processor.forceFlush()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "tracing_flush_failed",
        message: error instanceof Error ? error.message : "unknown",
      })
    )
  }
}
