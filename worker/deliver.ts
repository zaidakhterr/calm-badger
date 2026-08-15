/**
 * Simulated external delivery.
 *
 * Delivery is an owner decision, not something the pipeline does on its own, so
 * it runs in the request handler rather than in the durable workflow: the
 * transformation is local, deterministic, and calls no provider, and the
 * workflow's hibernation is reserved for human review. The owner picks an
 * adapter, may inspect the payload it would produce, and only then delivers.
 *
 * "Delivering" transforms the canonical quote, records the payload and a
 * synthetic identifier, and closes the graph. Nothing is sent anywhere.
 */

import {
  deliverQuote,
  ADAPTERS,
  type AdapterDelivery,
  type AdapterId,
} from "./adapters"
import { loadQuote } from "./build-estimate"

export const DELIVER_STEP_KEY = "deliver"
export const DELIVERED_STEP_KEY = "delivered"

export type DeliveryOutcome =
  | { state: "delivered"; delivery: AdapterDelivery }
  | { state: "not_priced" }
  | { state: "already_delivered"; delivery: AdapterDelivery }

export type StoredDelivery = {
  adapter: AdapterId
  externalEstimateId: string
  payload: unknown
  receipt: AdapterDelivery["receipt"]
  deliveredAt: string
}

/**
 * The payload the chosen adapter would produce, before anything is delivered.
 * Reading it changes nothing.
 */
export async function previewDelivery(
  env: Env,
  runId: string,
  adapter: AdapterId
): Promise<{ payload: unknown; adapter: (typeof ADAPTERS)[AdapterId] } | null> {
  const quote = await loadQuote(env, runId)
  if (!quote) return null

  // The preview is the same transformation delivery performs; only the
  // acknowledgement is withheld until the owner asks for it.
  const { payload } = deliverQuote(adapter, quote, quote.issuedAt)

  return { payload, adapter: ADAPTERS[adapter] }
}

export async function deliverRun(
  env: Env,
  runId: string,
  adapter: AdapterId
): Promise<DeliveryOutcome> {
  const existing = await loadDelivery(env, runId)

  if (existing) {
    // Repair a delivery written by an older build that failed before closing
    // the graph. The updates are idempotent, so an ordinary repeat is cheap.
    await finalizeStoredDelivery(env, runId, existing)

    return {
      state: "already_delivered",
      delivery: {
        adapter: ADAPTERS[existing.adapter],
        payload: existing.payload,
        receipt: existing.receipt,
      },
    }
  }

  const quote = await loadQuote(env, runId)
  if (!quote) return { state: "not_priced" }

  const deliveredAt = new Date().toISOString()
  const delivery = deliverQuote(adapter, quote, deliveredAt)

  // The read above is not authority to insert: two concurrent requests both
  // see no delivery. The single-row primary key is the authority, so the
  // insert itself decides which request delivered, and the loser reports what
  // was delivered rather than failing.
  // D1 batches are transactions: the delivery row and all three graph/run
  // transitions commit together, or none of them do. The EXISTS guards make a
  // concurrent loser a no-op when it proposed a different adapter.
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
    ...deliveryCompletionStatements(env, runId, {
      adapter,
      adapterName: delivery.adapter.name,
      externalEstimateId: delivery.receipt.externalEstimateId,
      deliveredAt,
      guardStoredDelivery: true,
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
            adapter: ADAPTERS[delivered.adapter],
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
  adapter: AdapterId
  adapterName: string
  externalEstimateId: string
  deliveredAt: string
  guardStoredDelivery: boolean
}

/** The graph/run half of delivery, reusable to repair legacy partial writes. */
function deliveryCompletionStatements(
  env: Env,
  runId: string,
  completion: DeliveryCompletion
): D1PreparedStatement[] {
  const guard = completion.guardStoredDelivery
    ? `AND EXISTS (
         SELECT 1 FROM run_deliveries
          WHERE run_id = ? AND adapter = ? AND external_estimate_id = ?
            AND delivered_at = ?
       )`
    : ""
  const guardBindings = completion.guardStoredDelivery
    ? [
        runId,
        completion.adapter,
        completion.externalEstimateId,
        completion.deliveredAt,
      ]
    : []

  return [
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'complete', summary = ?,
              started_at = COALESCE(started_at, ?),
              completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ? ${guard}`
    ).bind(
      `Transformed the canonical quote for ${completion.adapterName} (simulated).`,
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
      `Simulated external estimate ${completion.externalEstimateId} accepted by ${completion.adapterName}.`,
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

async function finalizeStoredDelivery(
  env: Env,
  runId: string,
  delivery: StoredDelivery
): Promise<void> {
  await env.DB.batch(
    deliveryCompletionStatements(env, runId, {
      adapter: delivery.adapter,
      adapterName: ADAPTERS[delivery.adapter].name,
      externalEstimateId: delivery.externalEstimateId,
      deliveredAt: delivery.deliveredAt,
      guardStoredDelivery: false,
    })
  )
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
    adapter: row.adapter as AdapterId,
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
