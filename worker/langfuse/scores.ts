import { LANGFUSE_SCORE_NAMES, type LangfuseScore } from "./contract"
import {
  createObservationId,
  createScoreId,
  MATCH_LINE_OBSERVATION_NAME,
} from "./ids"

/** One trace-level score per signal and run, including across retries. */
export async function reviewApprovedScore(
  runId: string,
  traceId: string,
  value: 0 | 1
): Promise<LangfuseScore> {
  const name = LANGFUSE_SCORE_NAMES.reviewApproved
  return {
    id: await createScoreId(runId, name, "trace"),
    traceId,
    name,
    value,
  }
}

/** One observation-level score per reviewed product line and run. */
export async function reviewLineScore(
  runId: string,
  traceId: string,
  position: number,
  value: 0 | 1,
  comment?: string
): Promise<LangfuseScore> {
  const name = LANGFUSE_SCORE_NAMES.reviewLineCorrect
  const score: LangfuseScore = {
    id: await createScoreId(
      runId,
      name,
      `${MATCH_LINE_OBSERVATION_NAME}:${position}`
    ),
    traceId,
    observationId: await createObservationId(
      runId,
      MATCH_LINE_OBSERVATION_NAME,
      position
    ),
    name,
    value,
  }

  if (comment !== undefined) score.comment = comment
  return score
}
