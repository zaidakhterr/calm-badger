import { createTraceId } from "@langfuse/tracing"
import { z } from "zod"

import { readConfig } from "./env"
import { ownerLineThumbsScore, ownerQuoteThumbsScore } from "./langfuse/scores"
import { maskContactDetails } from "./langfuse/tracing"
import { selectLangfuseProvider } from "./providers/langfuse"

export const OWNER_FEEDBACK_BODY_SCHEMA = z
  .object({
    target: z.union([z.number().int().positive(), z.literal("quote")]),
    value: z.enum(["up", "down"]),
    comment: z.string().trim().min(1).max(500).optional(),
  })
  .strict()

export type OwnerFeedback = z.infer<typeof OWNER_FEEDBACK_BODY_SCHEMA>

export type OwnerFeedbackOutcome =
  | { state: "recorded" }
  | { state: "before_matches" }
  | { state: "unknown_line" }
  | { state: "unavailable" }

/** Records one owner signal after the run has produced its product matches. */
export async function recordOwnerFeedback(
  env: Env,
  runId: string,
  feedback: OwnerFeedback
): Promise<OwnerFeedbackOutcome> {
  const matches = await env.DB.prepare(
    `SELECT position FROM run_line_matches WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(runId)
    .all<{ position: number }>()

  if (matches.results.length === 0) return { state: "before_matches" }
  if (
    feedback.target !== "quote" &&
    !matches.results.some((line) => line.position === feedback.target)
  ) {
    return { state: "unknown_line" }
  }

  const traceId = await createTraceId(runId)
  const value = feedback.value === "up" ? 1 : 0
  // The score API bypasses the span processor, so the comment is masked here.
  const comment =
    feedback.comment === undefined
      ? undefined
      : maskContactDetails({ data: feedback.comment })
  const score =
    feedback.target === "quote"
      ? await ownerQuoteThumbsScore(runId, traceId, value, comment)
      : await ownerLineThumbsScore(
          runId,
          traceId,
          feedback.target,
          value,
          comment
        )

  try {
    await selectLangfuseProvider(readConfig(env)).scores.write(score)
  } catch {
    console.error(
      JSON.stringify({ event: "owner_feedback_write_failed", runId })
    )
    return { state: "unavailable" }
  }
  return { state: "recorded" }
}
