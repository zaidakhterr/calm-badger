/**
 * The "Deliver" workflow step: simulated external delivery.
 *
 * Delivery follows pricing without anyone asking for it. The transformation is
 * local, deterministic, and calls no provider, so it runs as the last durable
 * step of the workflow: the canonical quote is transformed by the fixed
 * simulated webhook, the payload and a synthetic identifier are recorded, and
 * the graph closes. Nothing is sent anywhere.
 *
 * Like every other step, nothing is thrown: a failure ends as a terminal error
 * on the step and on the run rather than leaving the node waiting forever.
 */

import { z } from "zod"

import {
  ADAPTER_PAYLOAD_SCHEMA,
  ADAPTER_RECEIPT_SCHEMA,
  deliverQuote,
  DEFAULT_ADAPTER,
  type AdapterDelivery,
  type AdapterPayload,
  type AdapterReceipt,
} from "./adapters"
import { loadQuote } from "./build-estimate"
import { createRunStepRecorder } from "./run-steps"

export const DELIVER_STEP_KEY = "deliver"

/**
 * The `payload` and `receipt` columns of `run_deliveries`, as this step stores
 * them: the adapter's own two documents, JSON-encoded beside the identifier
 * they were acknowledged under.
 */
const STORED_JSON_SCHEMA = z.string().transform((raw, ctx) => {
  try {
    const decoded: unknown = JSON.parse(raw)
    return decoded
  } catch {
    ctx.addIssue({ code: "custom", message: "The column is not JSON text." })
    return z.NEVER
  }
})

const STORED_PAYLOAD_SCHEMA = STORED_JSON_SCHEMA.pipe(ADAPTER_PAYLOAD_SCHEMA)
const STORED_RECEIPT_SCHEMA = STORED_JSON_SCHEMA.pipe(ADAPTER_RECEIPT_SCHEMA)

/** The sentence delivery ends on, shared by the fresh and repair paths. */
const deliveredSummary = (externalEstimateId: string): string =>
  `Simulated external estimate ${externalEstimateId} accepted.`

export type DeliveryOutcome =
  | { state: "delivered"; delivery: AdapterDelivery }
  | { state: "already_delivered"; delivery: StoredDelivery }
  | { state: "not_priced" }
  | { state: "error"; message: string }

/**
 * A delivery as it was written down. The identifier and the moment are the
 * delivery — they are what says this run was delivered, and they are columns of
 * their own. The two documents beside them are what was sent and what came
 * back: `null` when the stored JSON no longer fits the adapter's contract, so
 * a delivery an earlier build wrote still reads as delivered.
 */
export type StoredDelivery = {
  adapter: string
  externalEstimateId: string
  payload: AdapterPayload | null
  receipt: AdapterReceipt | null
  deliveredAt: string
}

/**
 * Delivers a priced run once. Idempotent: a replayed durable step finds the
 * stored delivery and only makes sure the graph is closed over it.
 */
export async function deliverRun(
  env: Env,
  runId: string
): Promise<DeliveryOutcome> {
  const recorder = createRunStepRecorder(env, runId, DELIVER_STEP_KEY)

  try {
    return await deliverOnce(env, runId)
  } catch (error) {
    const message = "The system could not deliver the quote."

    console.error(
      JSON.stringify({
        event: "deliver_failed",
        runId,
        step: DELIVER_STEP_KEY,
        reason: "unexpected",
        error: error instanceof Error ? error.name : "unknown",
      })
    )

    try {
      await recorder.fail(message)
    } catch {
      // Nowhere left to record the failure; returning still stops the workflow.
    }

    return { state: "error", message }
  }
}

async function deliverOnce(env: Env, runId: string): Promise<DeliveryOutcome> {
  const adapter = DEFAULT_ADAPTER
  const existing = await loadDelivery(env, runId)

  if (existing) {
    // A replay, or a delivery written by an older build that failed before
    // closing the graph. The completion is idempotent, pinned to the stored
    // `delivered_at` so a repair reports when delivery happened, not when it
    // was noticed.
    await createRunStepRecorder(env, runId, DELIVER_STEP_KEY).complete(
      deliveredSummary(existing.externalEstimateId),
      { at: existing.deliveredAt }
    )

    return { state: "already_delivered", delivery: existing }
  }

  const quote = await loadQuote(env, runId)

  if (!quote) {
    const message = "The run does not have a quote to deliver."
    await createRunStepRecorder(env, runId, DELIVER_STEP_KEY).fail(message)
    return { state: "not_priced" }
  }

  const deliveredAt = new Date().toISOString()
  const delivery = deliverQuote(quote, deliveredAt)

  // D1 batches are transactions: the delivery row and the step/run completion
  // commit together, or none of them do. The insert is guarded on the run still
  // being a live, priced run — a reset that raced this step deletes the run,
  // and a delivery must not be written against a run that no longer exists.
  const [insert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO run_deliveries (
         run_id, adapter, external_estimate_id, payload, receipt, delivered_at
       )
       SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
            FROM runs r
            JOIN run_quotes q ON q.run_id = r.id
           WHERE r.id = ? AND r.status = 'active'
             AND r.workflow_state = 'estimate_built'
        )
       ON CONFLICT (run_id) DO NOTHING`
    ).bind(
      runId,
      adapter,
      delivery.receipt.externalEstimateId,
      JSON.stringify(delivery.payload),
      JSON.stringify(delivery.receipt),
      deliveredAt,
      runId
    ),
    ...createRunStepRecorder(env, runId, DELIVER_STEP_KEY).completeStatements(
      deliveredSummary(delivery.receipt.externalEstimateId),
      { at: deliveredAt }
    ),
  ])

  if (insert.meta.changes !== 1) {
    // The guard refused: the run is gone or no longer priced. Nothing was
    // written, and there is nothing to deliver.
    return { state: "not_priced" }
  }

  console.log(
    JSON.stringify({
      event: "run_delivered",
      runId,
      step: DELIVER_STEP_KEY,
      adapter,
      simulated: true,
    })
  )

  return { state: "delivered", delivery }
}

export async function loadDelivery(
  env: Env,
  runId: string
): Promise<StoredDelivery | null> {
  const row = await env.DB.prepare(
    `SELECT adapter, external_estimate_id, payload, receipt, delivered_at
       FROM run_deliveries WHERE run_id = ?`
  )
    .bind(runId)
    .first<{
      adapter: string
      external_estimate_id: string
      payload: string
      receipt: string
      delivered_at: string
    }>()

  if (!row) return null

  const payload = STORED_PAYLOAD_SCHEMA.safeParse(row.payload)
  const receipt = STORED_RECEIPT_SCHEMA.safeParse(row.receipt)

  return {
    adapter: row.adapter,
    externalEstimateId: row.external_estimate_id,
    payload: payload.success ? payload.data : null,
    receipt: receipt.success ? receipt.data : null,
    deliveredAt: row.delivered_at,
  }
}
