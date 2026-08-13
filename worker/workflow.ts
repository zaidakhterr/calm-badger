import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"

import { readDocuments } from "./read-documents"
import { RFQ_RECEIVED_STEP_KEY } from "./runs"

export type RfqWorkflowParams = {
  runId: string
}

export type RfqWorkflowResult = {
  runId: string
  state: "documents_read" | "failed"
  acknowledgedAt: string
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

    // The provider failure path is handled inside the step, which records a
    // terminal error and returns. Nothing is thrown, so the workflow does not
    // retry a paid provider call and the graph never stays active forever.
    const outcome = await step.do("read documents", async () =>
      readDocuments(this.env, runId)
    )

    return {
      runId,
      state: outcome.state === "complete" ? "documents_read" : "failed",
      acknowledgedAt,
    }
  }
}
