import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"

import { buildEstimate } from "./build-estimate"
import { matchProducts } from "./match-products"
import { readDocuments } from "./read-documents"
import { resolveCustomer } from "./resolve-customer"
import { retrieveCandidates } from "./retrieve-candidates"
import {
  expireReview,
  openReview,
  readReviewState,
  REVIEW_EVENT_TYPE,
} from "./review"
import { RFQ_RECEIVED_STEP_KEY } from "./runs"
import { structureRfq } from "./structure-rfq"

export type RfqWorkflowParams = {
  runId: string
}

export type RfqWorkflowResult = {
  runId: string
  state:
    | "estimate_built"
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

    const acknowledgedAt = await step.do("record RFQ receipt", async () => {
      const now = new Date().toISOString()

      // Idempotent: the request handler already persisted RFQ receipt, so the
      // durable orchestrator only confirms it owns the run.
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE run_steps
              SET status = 'complete',
                  completed_at = COALESCE(completed_at, ?),
                  updated_at = ?
            WHERE run_id = ? AND step_key = ?`
        ).bind(now, now, runId, RFQ_RECEIVED_STEP_KEY),
        this.env.DB.prepare(
          `UPDATE runs SET workflow_state = 'accepted', updated_at = ? WHERE id = ?`
        ).bind(now, runId),
      ])

      console.log(
        JSON.stringify({
          event: "workflow_step_completed",
          runId,
          step: RFQ_RECEIVED_STEP_KEY,
          instanceId: event.instanceId,
        })
      )

      return now
    })

    // Every failure path is handled inside each step, which records a terminal
    // error and returns. Nothing is thrown, so the workflow does not retry a
    // paid provider call and the graph never stays active forever. A step that
    // did not complete stops the sequence here, so no later step can build on
    // data that failed validation.
    const documents = await step.do("read documents", async () =>
      readDocuments(this.env, runId)
    )

    if (documents.state !== "complete") {
      return failure(runId, acknowledgedAt)
    }

    const structured = await step.do("structure RFQ", async () =>
      structureRfq(this.env, runId)
    )

    if (structured.state !== "complete") {
      return failure(runId, acknowledgedAt)
    }

    const customer = await step.do("resolve customer", async () =>
      resolveCustomer(this.env, runId)
    )

    if (customer.state === "error") {
      return failure(runId, acknowledgedAt)
    }

    // An unresolved customer is a fact, not a failure: matching continues, and
    // only that customer's private vocabulary is unavailable to it.
    const customerResolved = customer.state === "resolved"

    const retrieved = await step.do("retrieve candidates", async () =>
      retrieveCandidates(this.env, runId)
    )

    if (retrieved.state !== "complete") {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    const matched = await step.do("match products", async () =>
      matchProducts(this.env, runId)
    )

    if (matched.state !== "complete") {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    // Everything the run could not decide for itself is consolidated into one
    // node here. When there is nothing to ask, no review node is ever shown and
    // pricing follows immediately.
    const review = await step.do("open review", async () =>
      openReview(this.env, runId)
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
      // replayed, forged, or racing event therefore cannot move this run.
      const settled = await step.do("read review decision", async () =>
        readReviewState(this.env, runId)
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
    const estimate = await step.do("build estimate", async () =>
      buildEstimate(this.env, runId, { reviewed: review.state === "required" })
    )

    if (estimate.state === "error") {
      return failure(runId, acknowledgedAt, customerResolved)
    }

    return {
      runId,
      state:
        estimate.state === "complete"
          ? "estimate_built"
          : "matches_need_review",
      acknowledgedAt,
      customerResolved,
    }
  }
}

function failure(
  runId: string,
  acknowledgedAt: string,
  customerResolved = false
): RfqWorkflowResult {
  return { runId, state: "failed", acknowledgedAt, customerResolved }
}
