import { z } from "zod"

export type PromptName = "rfq/extract" | "rfq/rerank"

/** Only the chat messages and JSON configuration cross the SDK boundary. */
export const LANGFUSE_PROMPT_SCHEMA = z.object({
  name: z.enum(["rfq/extract", "rfq/rerank"]),
  version: z.number().int().nonnegative(),
  isFallback: z.boolean(),
  prompt: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ),
  config: z.record(z.string(), z.json()),
})

export type LangfusePrompt = z.infer<typeof LANGFUSE_PROMPT_SCHEMA>

/** Stable signal names shared by review outcomes and owner feedback. */
export const LANGFUSE_SCORE_NAMES = {
  reviewLineCorrect: "review-line-correct",
  reviewApproved: "review-approved",
  ownerLineThumbs: "owner-line-thumbs",
  ownerQuoteThumbs: "owner-quote-thumbs",
} as const

export type LangfuseScoreName =
  (typeof LANGFUSE_SCORE_NAMES)[keyof typeof LANGFUSE_SCORE_NAMES]

/** These signals belong to a run or to one observation within that run. */
export type LangfuseScore = {
  id: string
  traceId: string
  observationId?: string
  name: LangfuseScoreName
  value: 0 | 1
  comment?: string
}

export interface LangfuseProvider {
  readonly name: "langfuse" | "contract-fake" | "none"
  prompts: {
    get(name: PromptName, sourceLabels?: string[]): Promise<LangfusePrompt>
  }
  /** Resolves after ingestion succeeds; callers must await it or use waitUntil. */
  scores: { write(score: LangfuseScore): Promise<void> }
}
