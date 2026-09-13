import { z } from "zod"

import { RERANK_INSTRUCTION, rerankSchema } from "../product-matching"
import {
  RFQ_EXTRACTION_INSTRUCTION,
  rfqExtractionSchema,
} from "../rfq-extraction"

import {
  LANGFUSE_PROMPT_SCHEMA,
  type LangfusePrompt,
  type PromptName,
} from "./contract"

/** Bundled copies reference the existing instructions; model calls still use those directly. */
const fallbacks = {
  "rfq/extract": LANGFUSE_PROMPT_SCHEMA.parse({
    name: "rfq/extract",
    version: 0,
    isFallback: true,
    prompt: [
      { role: "system", content: RFQ_EXTRACTION_INSTRUCTION },
      { role: "user", content: "{{documents}}" },
    ],
    config: {
      model: "openai/gpt-5.6-luna",
      temperature: 0,
      max_tokens: 4000,
      response_format: z.toJSONSchema(rfqExtractionSchema),
    },
  }),
  "rfq/rerank": LANGFUSE_PROMPT_SCHEMA.parse({
    name: "rfq/rerank",
    version: 0,
    isFallback: true,
    prompt: [
      { role: "system", content: RERANK_INSTRUCTION },
      { role: "user", content: "{{request}}" },
    ],
    config: {
      model: "openai/gpt-5.6-luna",
      temperature: 0,
      max_tokens: 1500,
      winner_strength: 0.55,
      winner_gap: 0.12,
      response_format: z.toJSONSchema(rerankSchema),
    },
  }),
} satisfies Record<PromptName, LangfusePrompt>

export function bundledPrompt(name: PromptName): LangfusePrompt {
  return structuredClone(fallbacks[name])
}
