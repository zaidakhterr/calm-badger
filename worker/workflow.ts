import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"

import { RFQ_RECEIVED_STEP_KEY } from "./runs"

export type RfqWorkflowParams = {
  runId: string
}

export type RfqWorkflowResult = {
  runId: string
  state: "accepted"
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

    return { runId, state: "accepted", acknowledgedAt }
  }
}
