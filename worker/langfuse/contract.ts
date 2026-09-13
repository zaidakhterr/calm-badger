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

/** These signals belong to a run or to one observation within that run. */
export type LangfuseScore = {
  id: string
  traceId: string
  observationId?: string
  name:
    | "review-line-correct"
    | "review-approved"
    | "owner-line-thumbs"
    | "owner-quote-thumbs"
  value: 0 | 1
  comment?: string
}

export interface LangfuseProvider {
  readonly name: "langfuse" | "contract-fake" | "none"
  prompts: { get(name: PromptName): Promise<LangfusePrompt> }
  /** Resolves after ingestion succeeds; callers must await it or use waitUntil. */
  scores: { write(score: LangfuseScore): Promise<void> }
}
