import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"

import { buildEstimate } from "./build-estimate"
import { matchProducts } from "./match-products"
import { readDocuments } from "./read-documents"
import { resolveCustomer } from "./resolve-customer"
import { retrieveCandidates } from "./retrieve-candidates"
import { RFQ_RECEIVED_STEP_KEY } from "./runs"
import { structureRfq } from "./structure-rfq"

export type RfqWorkflowParams = {
  runId: string
}

export type RfqWorkflowResult = {
  runId: string
  state: "estimate_built" | "matches_need_review" | "failed"
  acknowledgedAt: string
  /** Whether identity was settled. An unresolved run still matches products. */
  customerResolved: boolean
}

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

    // Pricing decides for itself whether the run is priceable: identity
    // settled, every line matched and quantified. A run that is not stops here
    // with the estimate node still waiting, and the review node of the next
    // ticket is what releases it. Nothing unreviewed is ever priced.
    const estimate = await step.do("build estimate", async () =>
      buildEstimate(this.env, runId)
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
