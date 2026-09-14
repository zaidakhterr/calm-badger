import { AsyncLocalStorage } from "node:async_hooks"
import { createTraceId } from "@langfuse/tracing"
import {
  RandomIdGenerator,
  type IdGenerator,
} from "@opentelemetry/sdk-trace-base"

type RequestedSpanId = {
  id: string
  claimed: boolean
}

const requestedSpanId = new AsyncLocalStorage<RequestedSpanId>()
const randomIds = new RandomIdGenerator()

/** The stable name of the observation that decides one requested line. */
export const MATCH_LINE_OBSERVATION_NAME = "match-line"

/**
 * Derives the OpenTelemetry span id for one named observation of a run.
 *
 * Langfuse uses the span id as its observation id. The line position is part
 * of the seed because one run has one `match-line` observation per line.
 */
export async function createObservationId(
  runId: string,
  observationName: string,
  position: number
): Promise<string> {
  return (
    await createTraceId(
      JSON.stringify(["observation", runId, observationName, position])
    )
  ).slice(0, 16)
}

/** A stable id makes a retried score write update the same Langfuse score. */
export function createScoreId(
  runId: string,
  scoreName: string,
  subject: string
): Promise<string> {
  return createTraceId(JSON.stringify(["score", runId, scoreName, subject]))
}

/**
 * Gives the next span started in this async context a deterministic id.
 *
 * The request is consumed once. A model generation nested under the named
 * observation therefore keeps a random id instead of colliding with its
 * parent. Async-local state keeps simultaneous runs independent.
 */
export async function withObservationId<T>(
  runId: string,
  observationName: string,
  position: number,
  fn: () => T | Promise<T>
): Promise<T> {
  const id = await createObservationId(runId, observationName, position)
  return await requestedSpanId.run({ id, claimed: false }, fn)
}

/** Used by the Worker tracer provider to honour one requested span id. */
export const langfuseIdGenerator: IdGenerator = {
  generateTraceId: () => randomIds.generateTraceId(),
  generateSpanId: () => {
    const requested = requestedSpanId.getStore()
    if (!requested || requested.claimed) return randomIds.generateSpanId()

    requested.claimed = true
    return requested.id
  },
}
