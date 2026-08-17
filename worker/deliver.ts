/**
 * Simulated external delivery.
 *
 * Delivery is an owner decision, not something the pipeline does on its own, so
 * it runs in the request handler rather than in the durable workflow: the
 * transformation is local, deterministic, and calls no provider, and the
 * workflow's hibernation is reserved for human review. The owner may inspect
 * the fixed webhook payload and then deliberately deliver it.
 *
 * "Delivering" transforms the canonical quote, records the payload and a
 * synthetic identifier, and closes the graph. Nothing is sent anywhere.
 */

import {
  deliverQuote,
  ADAPTERS,
  DEFAULT_ADAPTER,
  storedAdapterDescription,
  type AdapterDelivery,
  type AdapterDescription,
} from "./adapters"
import { loadQuote } from "./build-estimate"
import { createRunStepRecorder } from "./run-steps"

export const DELIVER_STEP_KEY = "deliver"
export const DELIVERED_STEP_KEY = "delivered"

/** The two sentences delivery ends on, shared by the fresh and repair paths. */
const DELIVER_SUMMARY =
  "Canonical quote transformed for simulated webhook delivery."
const deliveredSummary = (externalEstimateId: string): string =>
  `Simulated external estimate ${externalEstimateId} accepted.`

export type DeliveryOutcome =
  | { state: "delivered"; delivery: AdapterDelivery }
  | { state: "not_priced" }
  | { state: "already_delivered"; delivery: AdapterDelivery }

export type StoredDelivery = {
  adapter: string
  externalEstimateId: string
  payload: unknown
  receipt: AdapterDelivery["receipt"]
  deliveredAt: string
}

/**
 * The payload the fixed webhook would produce, before anything is delivered.
 * Reading it changes nothing.
 */
export async function previewDelivery(
  env: Env,
  runId: string
): Promise<{ payload: unknown; adapter: AdapterDescription } | null> {
  const quote = await loadQuote(env, runId)
  if (!quote) return null

  // The preview is the same transformation delivery performs; only the
  // acknowledgement is withheld until the owner asks for it.
  const { payload } = deliverQuote(quote, quote.issuedAt)

  return { payload, adapter: ADAPTERS[DEFAULT_ADAPTER] }
}

export async function deliverRun(
  env: Env,
  runId: string
): Promise<DeliveryOutcome> {
  const adapter = DEFAULT_ADAPTER
  const existing = await loadDelivery(env, runId)

  if (existing) {
    // Repair a delivery written by an older build that failed before closing
    // the graph. The updates are idempotent, so an ordinary repeat is cheap.
    await finalizeStoredDelivery(env, runId, existing)

    return {
      state: "already_delivered",
      delivery: {
        adapter: storedAdapterDescription(existing.adapter),
        payload: existing.payload,
        receipt: existing.receipt,
      },
    }
  }

  const quote = await loadQuote(env, runId)
  if (!quote) return { state: "not_priced" }

  const deliveredAt = new Date().toISOString()
  const delivery = deliverQuote(quote, deliveredAt)

  // The read above is not authority to insert: two concurrent requests both
  // see no delivery. The single-row primary key is the authority, so the
  // insert itself decides which request delivered, and the loser reports what
  // was delivered rather than failing.
  // D1 batches are transactions: the delivery row and all three graph/run
  // transitions commit together, or none of them do. The EXISTS guards make a
  // concurrent loser a no-op.
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
    ...guardedCompletionStatements(env, runId, {
      adapter,
      externalEstimateId: delivery.receipt.externalEstimateId,
      deliveredAt,
    }),
  ])

  if (insert.meta.changes !== 1) {
    // Another request won the race. The only way the row is gone again is a
    // reset in between, which leaves the run with nothing to deliver.
    const delivered = await loadDelivery(env, runId)

    return delivered
      ? {
          state: "already_delivered",
          delivery: {
            adapter: storedAdapterDescription(delivered.adapter),
            payload: delivered.payload,
            receipt: delivered.receipt,
          },
        }
      : { state: "not_priced" }
  }

  console.log(
    JSON.stringify({
      event: "run_delivered",
      runId,
      step: DELIVERED_STEP_KEY,
      adapter,
      simulated: true,
    })
  )

  return { state: "delivered", delivery }
}

type DeliveryCompletion = {
  adapter: string
  externalEstimateId: string
  deliveredAt: string
}

/**
 * The graph/run half of delivery for a delivery that is *being* written, kept
 * as bespoke SQL rather than composed from the Run-step recorder.
 *
 * These three statements ride in the insert's batch, and each is guarded on the
 * row the insert is trying to write. That is what makes a concurrent loser a
 * no-op: its insert hits `ON CONFLICT DO NOTHING`, so the guard finds no row
 * bearing *its* identifier and timestamp, and it leaves the winner's summaries
 * and completion times alone. A recorder-composed statement is unguarded by
 * design (the recorder owns status, timestamps and state, not the caller's
 * concurrency), so the loser would overwrite the winner's `delivered` sentence
 * with an identifier no stored delivery has. The guard cannot move into the
 * recorder either — it is delivery's own row it is checking. So the racing path
 * keeps its SQL: a deliberate carve-out from "the recorder is the only writer".
 *
 * The repair path below has no such race and does use the recorder.
 */
function guardedCompletionStatements(
  env: Env,
  runId: string,
  completion: DeliveryCompletion
): D1PreparedStatement[] {
  const guard = `AND EXISTS (
         SELECT 1 FROM run_deliveries
          WHERE run_id = ? AND adapter = ? AND external_estimate_id = ?
            AND delivered_at = ?
       )`
  const guardBindings = [
    runId,
    completion.adapter,
    completion.externalEstimateId,
    completion.deliveredAt,
  ]

  return [
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'complete', summary = ?,
              started_at = COALESCE(started_at, ?),
              completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ? ${guard}`
    ).bind(
      DELIVER_SUMMARY,
      completion.deliveredAt,
      completion.deliveredAt,
      completion.deliveredAt,
      runId,
      DELIVER_STEP_KEY,
      ...guardBindings
    ),
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'complete', summary = ?,
              started_at = COALESCE(started_at, ?),
              completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ? ${guard}`
    ).bind(
      deliveredSummary(completion.externalEstimateId),
      completion.deliveredAt,
      completion.deliveredAt,
      completion.deliveredAt,
      runId,
      DELIVERED_STEP_KEY,
      ...guardBindings
    ),
    env.DB.prepare(
      `UPDATE runs SET status = 'complete', workflow_state = 'delivered',
              updated_at = ?
        WHERE id = ? ${guard}`
    ).bind(completion.deliveredAt, runId, ...guardBindings),
  ]
}

/**
 * Close the graph over a delivery row that is already stored — a delivery
 * written by an older build that failed before finishing. The row exists and is
 * the only one there can be, so there is nothing to guard against and the
 * Run-step recorder writes both completions, pinned to the stored
 * `delivered_at` so a repair reports when delivery happened, not when it was
 * noticed. One batch, exactly as before.
 */
async function finalizeStoredDelivery(
  env: Env,
  runId: string,
  delivery: StoredDelivery
): Promise<void> {
  const at = delivery.deliveredAt

  await env.DB.batch([
    ...createRunStepRecorder(env, runId, "deliver").completeStatements(
      DELIVER_SUMMARY,
      { at }
    ),
    ...createRunStepRecorder(env, runId, "delivered").completeStatements(
      deliveredSummary(delivery.externalEstimateId),
      { at }
    ),
  ])
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

  return {
    adapter: row.adapter,
    externalEstimateId: row.external_estimate_id,
    payload: parseJson(row.payload),
    receipt: parseJson(row.receipt) as AdapterDelivery["receipt"],
    deliveredAt: row.delivered_at,
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
