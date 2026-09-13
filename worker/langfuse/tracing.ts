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
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk"
import { context, trace } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { registerTelemetry } from "ai"

import { readConfig } from "../env"
import type { LangfuseTarget } from "./target"
import { loadSources } from "../sources"

import { AsyncLocalStorageContextManager } from "./context-manager"
import { langfuseIdGenerator } from "./ids"

/**
 * The AI SDK reports every model call to the registered integration, which
 * turns it into a Langfuse generation. Registered once per isolate; with no
 * tracer provider installed, the generation is a no-op span.
 */
registerTelemetry(new LangfuseVercelAiSdkIntegration())

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
  sourceKind: string
  scenarioId: string | null
  sources: TracedSource[]
}

type RunTraceRow = {
  view_id: string
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
  let row: RunTraceRow | null
  let sources: TracedSource[]

  try {
    row = await env.DB.prepare(
      `SELECT view_id, source_kind, scenario_id FROM runs WHERE id = ?`
    )
      .bind(runId)
      .first<RunTraceRow>()
    sources = (await loadSources(env, runId)).map((source) => ({
      label: source.label,
      mediaType: source.mediaType,
      byteSize: source.byteSize,
    }))
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

  if (!row) return null

  return {
    runId,
    viewId: row.view_id,
    sourceKind: row.source_kind,
    scenarioId: row.scenario_id,
    sources,
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
  })

  const provider = new BasicTracerProvider({
    idGenerator: langfuseIdGenerator,
    spanProcessors: [processor],
    resource: resourceFromAttributes({ "service.name": "calm-badger" }),
  })

  context.setGlobalContextManager(new AsyncLocalStorageContextManager())
  trace.setGlobalTracerProvider(provider)

  return processor
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
