import { z } from "zod"

import { RERANK_CONTRACT } from "../product-matching"
import type { LangfusePrompt } from "./contract"
import { bundledPrompt } from "./fallbacks"
import { retainsRequiredFields, supportedPromptSchema } from "./prompt-schema"

const CONFIG = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().positive(),
  winner_strength: z.number().min(0).max(1),
  winner_gap: z.number().min(0).max(1),
  response_format: z.record(z.string(), z.json()),
})
const MESSAGES = z.tuple([
  z.object({ role: z.literal("system"), content: z.string().min(1) }),
  z.object({
    role: z.literal("user"),
    content: z.string().includes("{{request}}"),
  }),
])
const REQUIRED = z.json().parse(z.toJSONSchema(RERANK_CONTRACT))

/** Parsed once after fetching; the full JSON schema also goes unchanged to OpenRouter. */
export function rerankPrompt(prompt: LangfusePrompt) {
  const config = CONFIG.parse(prompt.config)
  const messages = MESSAGES.parse(prompt.prompt)
  if (
    !supportedPromptSchema(config.response_format) ||
    !retainsRequiredFields(config.response_format, REQUIRED)
  ) {
    throw new Error("Rerank prompt drops a required field")
  }
  return {
    prompt,
    config,
    messages,
    schema: z.fromJSONSchema(config.response_format),
  }
}

export type RerankPrompt = ReturnType<typeof rerankPrompt>

export function compatibleRerankPrompt(prompt: LangfusePrompt): LangfusePrompt {
  try {
    rerankPrompt(prompt)
    return prompt
  } catch {
    console.warn(
      JSON.stringify({
        event: "prompt_incompatible",
        name: prompt.name,
        version: prompt.version,
      })
    )
    return bundledPrompt("rfq/rerank")
  }
}
