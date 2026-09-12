import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"

import { DEFAULT_ADAPTER } from "./adapters"
import { captureFunnelEvent } from "./analytics"
import { buildEstimate } from "./build-estimate"
import { deliverRun, type DeliveryOutcome } from "./deliver"
import { ConfigError, readConfig } from "./env"
import { applyReviewProductDecision, matchProducts } from "./match-products"
import { readDocuments } from "./read-documents"
import { applyReviewCustomer, resolveCustomer } from "./resolve-customer"
import { retrieveCandidates } from "./retrieve-candidates"
import type { ReviewOutcome } from "./review"
import {
  expireReview,
  loadReviewOutcome,
  openReview,
  REVIEW_EVENT_TYPE,
  REVIEW_STEP_KEY,
} from "./review"
import { createRunStepRecorder } from "./run-steps"
import { RFQ_RECEIVED_STEP_KEY } from "./runs"
import { applyReviewLineDecision, structureRfq } from "./structure-rfq"
import {
  loadRunTraceContext,
  traceRunStep,
  type RunTraceContext,
} from "./tracing"

export type RfqWorkflowParams = {
  runId: string
}

export type RfqWorkflowResult = {
  runId: string
  state:
    | "delivered"
    | "matches_need_review"
    | "review_rejected"
    | "review_expired"
    | "failed"
  acknowledgedAt: string
  /** Whether identity was settled. An unresolved run still matches products. */
  customerResolved: boolean
}

/** What the Worker delivers once it has validated an owner's decision. */
export type ReviewEventPayload = { runId: string }

export class RfqWorkflow extends WorkflowEntrypoint<Env, RfqWorkflowParams> {
  async run(
    event: WorkflowEvent<RfqWorkflowParams>,
    step: WorkflowStep
  ): Promise<RfqWorkflowResult> {
    const { runId } = event.payload

    // The same fail-fast the Worker does, for the same reason: a run that
    // cannot be configured correctly must not reach a provider. The instance
    // ends here, with the run recorded as failed rather than left active.
    try {
      readConfig(this.env)
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "config_invalid",
          runId,
          instanceId: event.instanceId,
          issues: error instanceof ConfigError ? error.issues : [],
        })
      )

      await createRunStepRecorder(this.env, runId, "rfq-received").fail(
        "This deployment is not configured correctly, so the run stopped before it started."
      )

      return failure(runId, new Date().toISOString())
    }

    // What every observation of this run carries. One read, before any step.
    const run = await loadRunTraceContext(this.env, runId)

    // The first observation of the trace, so its input is the request as it
    // arrived: the scenario, the source kind, and what each source is.
    const acknowledgedAt = await step.do("record RFQ receipt", () =>
      traceReceipt(this.env, run, runId, event.instanceId)
    )

    // Every failure path in the steps below is handled inside the step, which
    // records a terminal error and returns. Nothing is thrown, so the workflow
    // does not retry a paid provider call and the graph never stays active
    // forever. A step that did not complete stops the sequence here, so no
    // later step can build on data that failed validation. (The one step that
    // deliberately throws is `apply review outcome`: it calls no provider, and
    // a half-applied correction must be retried, not recorded as a success.)
    const documents = await step.do("read documents", () =>
      traceRunStep(this.env, run, { name: "read-documents" }, () =>
        readDocuments(this.env, runId)
      )
    )

    if (documents.state !== "complete") {
      return failure(runId, acknowledgedAt)
    }

    const structured = await step.do("structure RFQ", () =>
      traceRunStep(this.env, run, { name: "structure-rfq" }, () =>
        structureRfq(this.env, runId)
      )
    )

    if (structured.state !== "complete") {
      return failure(runId, acknowledgedAt)
    }

    const customer = await step.do("resolve customer", () =>
      traceRunStep(
        this.env,
        run,
        { name: "resolve-customer", asType: "retriever" },
        () => resolveCustomer(this.env, runId)
      )
    )

    if (customer.state === "error") {
      return failure(runId, acknowledgedAt)
    }

    // An unresolved customer is a fact, not a failure: matching continues, and
    // only that customer's private vocabulary is unavailable to it.
    const customerResolved = customer.state === "resolved"

    const retrieved = await step.do("retrieve candidates", () =>
      traceRunStep(
        this.env,
        run,
        { name: "retrieve-candidates", asType: "retriever" },
        () => retrieveCandidates(this.env, runId)
      )
    )

    if (retrieved.state !== "complete") {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    const matched = await step.do("match products", () =>
      traceRunStep(this.env, run, { name: "match-products" }, () =>
        matchProducts(this.env, runId)
      )
    )

    if (matched.state !== "complete") {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    // Everything the run could not decide for itself is consolidated into one
    // node here. When there is nothing to ask, no review node is ever shown and
    // pricing follows immediately.
    const review = await step.do("open review", () =>
      traceRunStep(this.env, run, { name: "open-review" }, () =>
        openReview(this.env, runId)
      )
    )

    if (review.state === "error") {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    if (review.state === "required") {
      // The instance hibernates here. It consumes nothing while it waits, and
      // the client does not have to stay open to keep the run alive.
      try {
        await step.waitForEvent<ReviewEventPayload>("owner review", {
          type: REVIEW_EVENT_TYPE,
          timeout: review.timeoutMs,
        })
      } catch {
        // A timeout is the ordinary way this wait ends without a decision. It
        // is not proof of one: the Worker may have persisted an approval that
        // raced the deadline, so the persisted state below decides, and only a
        // review still pending is expired.
        await step.do("close review window", async () => {
          await expireReview(this.env, runId)
          return true
        })
      }

      // The event proves nothing on its own; the persisted review does. A
      // replayed, forged, or racing event therefore cannot move this run — and
      // whatever the persisted review says is applied here, in one durable
      // step, before anything downstream reads the corrected facts.
      const settled = await step.do("apply review outcome", () =>
        traceReviewOutcome(this.env, run, runId)
      )

      if (settled !== "approved") {
        return {
          runId,
          state: settled === "rejected" ? "review_rejected" : "review_expired",
          acknowledgedAt,
          customerResolved,
        }
      }
    }

    // Pricing decides for itself whether the run is priceable: identity
    // settled, every line matched and quantified. Approved corrections are
    // already written into those same facts, so the corrected run is priced by
    // exactly the deterministic path an untouched run takes.
    const estimate = await step.do("build estimate", () =>
      traceRunStep(
        this.env,
        run,
        {
          name: "build-estimate",
          input: { reviewed: review.state === "required" },
        },
        () =>
          buildEstimate(this.env, runId, {
            reviewed: review.state === "required",
          })
      )
    )

    if (estimate.state === "error") {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    if (estimate.state === "blocked") {
      return {
        runId,
        state: "matches_need_review",
        acknowledgedAt,
        customerResolved,
      }
    }

    // Delivery needs no one's permission: the quote is priced, so it is
    // transformed by the fixed simulated webhook and the graph closes. The
    // step is idempotent, so a replay finds the stored delivery and stops.
    const delivered = await step.do("deliver", () =>
      traceRunStep(
        this.env,
        run,
        {
          name: "deliver-quote",
          asType: "tool",
          input: { adapter: DEFAULT_ADAPTER },
          // The payload is stored evidence; the trace records the receipt.
          output: summarizeDelivery,
        },
        () => deliverRun(this.env, runId)
      )
    )

    if (delivered.state === "delivered") {
      // The end of the funnel: the fixed destination, and nothing about what
      // was sent. Captured once, on the replay-safe fresh path only.
      captureFunnelEvent(this.env, this.ctx, {
        event: "rfq_quote_delivered",
        distinctId: runId,
        properties: { adapter: DEFAULT_ADAPTER },
      })
    }

    if (
      delivered.state !== "delivered" &&
      delivered.state !== "already_delivered"
    ) {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    return {
      runId,
      state: "delivered",
      acknowledgedAt,
      customerResolved,
    }
  }
}

/**
 * Applies what the owner decided, then records the review node's ending.
 *
 * Review owns the decision; it does not own the facts a decision corrects. So
 * each correction is handed to the step that owns those facts — identity to
 * `resolve-customer`, quantities and confirmed fields to `structure-rfq`, the
 * chosen article and the wording it teaches to `match-products` — and only
 * then is the node completed. The completion is the "applied" marker: it is
 * written last, so a run whose review node reads `complete` has every
 * correction in place behind it.
 *
 * Order matters once: identity first, because the alias a product correction
 * teaches is scoped to the customer this run resolved to.
 *
 * Idempotent, and deliberately not defensive. Every apply is an UPSERT or an
 * UPDATE to the same values, so a retried step converges; anything genuinely
 * missing throws, and a durable step that throws is retried rather than
 * recorded as an applied outcome.
 */
export async function applyReviewOutcome(
  env: Env,
  runId: string
): Promise<ReviewOutcome["state"] | "pending"> {
  const outcome = await loadReviewOutcome(env, runId)

  // Woken with nothing persisted: the decision is still the owner's to make,
  // and this instance has no outcome to apply. The wait has already ended, so
  // the run stops here exactly as an undecided one does.
  if (!outcome) return "pending"

  const recorder = createRunStepRecorder(env, runId, REVIEW_STEP_KEY)

  if (outcome.state === "rejected") {
    await recorder.complete(
      "The owner rejected the review. The run stops here.",
      { variant: "rejected" }
    )
    return "rejected"
  }

  if (outcome.state === "expired") {
    await recorder.complete("The review time expired. The run stops here.", {
      variant: "expired",
    })
    return "expired"
  }

  for (const decision of outcome.decisions) {
    if (decision.kind === "customer") {
      await applyReviewCustomer(env, runId, { customerId: decision.customerId })
    }
  }

  for (const decision of outcome.decisions) {
    if (decision.kind === "quantity" || decision.kind === "field") {
      await applyReviewLineDecision(env, runId, decision)
    }
  }

  for (const decision of outcome.decisions) {
    if (decision.kind === "product") {
      await applyReviewProductDecision(env, runId, decision)
    }
  }

  const count = outcome.decisions.length

  await recorder.complete(
    `The owner confirmed ${count} ${count === 1 ? "item" : "items"}. The run continues.`,
    { variant: "approved" }
  )

  console.log(
    JSON.stringify({
      event: "review_outcome_applied",
      runId,
      step: REVIEW_STEP_KEY,
      decisions: count,
    })
  )

  return "approved"
}

/**
 * Records RFQ receipt as the trace's first observation.
 *
 * Idempotent: the request handler already persisted RFQ receipt, so the
 * durable orchestrator only confirms it owns the run. The receipt sentence and
 * any earlier completion time are preserved by the recorder's `rfq-received`
 * row, so a replay changes nothing. The step's stored value stays the bare
 * timestamp it always was.
 */
async function traceReceipt(
  env: Env,
  run: RunTraceContext | null,
  runId: string,
  instanceId: string
): Promise<string> {
  const traced = await traceRunStep(
    env,
    run,
    {
      name: "receive-rfq",
      input: {
        scenarioId: run?.scenarioId ?? null,
        sourceKind: run?.sourceKind ?? null,
        sources: run?.sources ?? [],
      },
    },
    async () => {
      const now = new Date().toISOString()

      await createRunStepRecorder(env, runId, "rfq-received").complete(null, {
        at: now,
      })

      console.log(
        JSON.stringify({
          event: "workflow_step_completed",
          runId,
          step: RFQ_RECEIVED_STEP_KEY,
          instanceId,
        })
      )

      return {
        state: "received",
        sourceCount: run?.sources.length ?? 0,
        acknowledgedAt: now,
      }
    }
  )

  return traced.acknowledgedAt
}

/**
 * The review outcome as one traced step. The outcome is a bare state, so it is
 * wrapped for the observation and unwrapped for the workflow, which keeps the
 * durable step's stored value exactly what it was.
 */
async function traceReviewOutcome(
  env: Env,
  run: RunTraceContext | null,
  runId: string
): Promise<ReviewOutcome["state"] | "pending"> {
  const traced = await traceRunStep(
    env,
    run,
    { name: "apply-review-outcome" },
    async () => ({ state: await applyReviewOutcome(env, runId) })
  )

  return traced.state
}

/** What the trace keeps of a delivery: the receipt, never the payload. */
type DeliverySummary =
  | { state: "delivered"; externalEstimateId: string; acceptedAt: string }
  | {
      state: "already_delivered"
      externalEstimateId: string
      deliveredAt: string
    }
  | { state: "not_priced" }
  | { state: "error"; message: string }

function summarizeDelivery(outcome: DeliveryOutcome): DeliverySummary {
  switch (outcome.state) {
    case "delivered":
      return {
        state: outcome.state,
        externalEstimateId: outcome.delivery.receipt.externalEstimateId,
        acceptedAt: outcome.delivery.receipt.acceptedAt,
      }
    case "already_delivered":
      return {
        state: outcome.state,
        externalEstimateId: outcome.delivery.externalEstimateId,
        deliveredAt: outcome.delivery.deliveredAt,
      }
    default:
      return outcome
  }
}

function failure(
  runId: string,
  acknowledgedAt: string,
  customerResolved = false
): RfqWorkflowResult {
  return { runId, state: "failed", acknowledgedAt, customerResolved }
}
