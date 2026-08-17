import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"

import { buildEstimate } from "./build-estimate"
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
      // durable orchestrator only confirms it owns the run. The receipt
      // sentence and any earlier completion time are preserved by the
      // recorder's `rfq-received` row, so a replay changes nothing.
      await createRunStepRecorder(this.env, runId, "rfq-received").complete(
        null,
        { at: now }
      )

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

    // Every failure path in the steps below is handled inside the step, which
    // records a terminal error and returns. Nothing is thrown, so the workflow
    // does not retry a paid provider call and the graph never stays active
    // forever. A step that did not complete stops the sequence here, so no
    // later step can build on data that failed validation. (The one step that
    // deliberately throws is `apply review outcome`: it calls no provider, and
    // a half-applied correction must be retried, not recorded as a success.)
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
      // replayed, forged, or racing event therefore cannot move this run — and
      // whatever the persisted review says is applied here, in one durable
      // step, before anything downstream reads the corrected facts.
      const settled = await step.do("apply review outcome", async () =>
        applyReviewOutcome(this.env, runId)
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
async function applyReviewOutcome(
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
      "Owner rejected this review, so the run stops here. Nothing was priced or delivered.",
      { variant: "rejected" }
    )
    return "rejected"
  }

  if (outcome.state === "expired") {
    await recorder.complete(
      "The review window closed before a decision was made, so this run was never priced.",
      { variant: "expired" }
    )
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
    `Owner confirmed ${count} ${count === 1 ? "decision" : "decisions"}; the run continues to pricing.`,
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

function failure(
  runId: string,
  acknowledgedAt: string,
  customerResolved = false
): RfqWorkflowResult {
  return { runId, state: "failed", acknowledgedAt, customerResolved }
}
