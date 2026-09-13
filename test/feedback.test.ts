import { env, exports } from "cloudflare:workers"
import { createTraceId } from "@langfuse/tracing"
import { beforeEach, describe, expect, it } from "vitest"

import { LANGFUSE_SCORE_NAMES } from "../worker/langfuse/contract"
import {
  createObservationId,
  createScoreId,
  MATCH_LINE_OBSERVATION_NAME,
} from "../worker/langfuse/ids"
import {
  capturedLangfuseScores,
  resetCapturedLangfuseScores,
} from "../worker/providers/contract-fake-langfuse"
import { hashCapability } from "../worker/runs"

const base = "https://example.test"

async function storedRun(withMatch: boolean) {
  const runId = crypto.randomUUID()
  const viewId = `feedback-${crypto.randomUUID()}`
  const ownerCapability = `owner-${crypto.randomUUID()}`
  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO runs (
       id, view_id, owner_capability_hash, source_kind, scenario_id,
       status, workflow_state, created_at, updated_at
     ) VALUES (?, ?, ?, 'curated', 'routine-replenishment',
               'active', 'matching_products', ?, ?)`
  )
    .bind(runId, viewId, await hashCapability(ownerCapability), now, now)
    .run()

  if (withMatch) {
    await env.DB.prepare(
      `INSERT INTO run_line_matches (
         id, run_id, position, state, sku, method, confidence_label,
         confidence_score, winner_gap, reason, alternatives, created_at
       ) VALUES (?, ?, 1, 'accepted', 'NX-FLT-1120', 'exact_sku', 'High',
                 1, 1, 'The request names this product.', '[]', ?)`
    )
      .bind(crypto.randomUUID(), runId, now)
      .run()
  }

  return { runId, viewId, ownerCapability }
}

function sendFeedback(
  viewId: string,
  capability: string | null,
  body: { target: number | "quote"; value: "up" | "down"; comment?: string }
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" })
  if (capability) headers.set("authorization", `Bearer ${capability}`)

  return exports.default.fetch(`${base}/api/runs/${viewId}/feedback`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

async function capturedScoresForRun(runId: string) {
  const traceId = await createTraceId(runId)
  return capturedLangfuseScores().filter((score) => score.traceId === traceId)
}

describe("owner feedback", () => {
  beforeEach(resetCapturedLangfuseScores)

  it("writes line and quote thumbs with comments and overwrites one target", async () => {
    const { runId, viewId, ownerCapability } = await storedRun(true)
    const position = 1

    expect(
      (
        await sendFeedback(viewId, ownerCapability, {
          target: position,
          value: "up",
          comment: "Correct product",
        })
      ).status
    ).toBe(200)
    expect(
      (
        await sendFeedback(viewId, ownerCapability, {
          target: "quote",
          value: "down",
          comment: "Delivery date needs work",
        })
      ).status
    ).toBe(200)

    const traceId = await createTraceId(runId)

    expect(await capturedScoresForRun(runId)).toEqual([
      {
        id: await createScoreId(
          runId,
          LANGFUSE_SCORE_NAMES.ownerLineThumbs,
          `${MATCH_LINE_OBSERVATION_NAME}:${position}`
        ),
        traceId,
        observationId: await createObservationId(
          runId,
          MATCH_LINE_OBSERVATION_NAME,
          position
        ),
        name: LANGFUSE_SCORE_NAMES.ownerLineThumbs,
        value: 1,
        comment: "Correct product",
      },
      {
        id: await createScoreId(
          runId,
          LANGFUSE_SCORE_NAMES.ownerQuoteThumbs,
          "trace"
        ),
        traceId,
        name: LANGFUSE_SCORE_NAMES.ownerQuoteThumbs,
        value: 0,
        comment: "Delivery date needs work",
      },
    ])

    expect(
      (
        await sendFeedback(viewId, ownerCapability, {
          target: position,
          value: "down",
        })
      ).status
    ).toBe(200)
    expect(await capturedScoresForRun(runId)).toHaveLength(2)
    expect((await capturedScoresForRun(runId))[0]).toMatchObject({
      name: LANGFUSE_SCORE_NAMES.ownerLineThumbs,
      value: 0,
      comment: "Correct product",
    })

    expect(
      (
        await sendFeedback(viewId, ownerCapability, {
          target: position,
          value: "up",
          comment: "Updated after owner review",
        })
      ).status
    ).toBe(200)
    expect(await capturedScoresForRun(runId)).toHaveLength(2)
    expect((await capturedScoresForRun(runId))[0]).toMatchObject({
      id: await createScoreId(
        runId,
        LANGFUSE_SCORE_NAMES.ownerLineThumbs,
        `${MATCH_LINE_OBSERVATION_NAME}:${position}`
      ),
      value: 1,
      comment: "Updated after owner review",
    })
  })

  it("forbids a viewer from writing feedback", async () => {
    const { runId, viewId } = await storedRun(true)

    const response = await sendFeedback(viewId, "not-the-owner", {
      target: "quote",
      value: "up",
    })

    expect(response.status).toBe(403)
    expect(await capturedScoresForRun(runId)).toEqual([])
  })

  it("rejects feedback before the run has product matches", async () => {
    const { runId, viewId, ownerCapability } = await storedRun(false)

    const response = await sendFeedback(viewId, ownerCapability, {
      target: "quote",
      value: "up",
      comment: "Too soon",
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Feedback is available after product matches.",
    })
    expect(await capturedScoresForRun(runId)).toEqual([])
  })
})
