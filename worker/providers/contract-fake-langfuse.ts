import type { LangfuseProvider, LangfuseScore } from "../langfuse/contract"
import { z } from "zod"
import { compatibleExtractionPrompt } from "../langfuse/extraction-prompt"
import { bundledPrompt } from "../langfuse/fallbacks"
import { compatibleRerankPrompt } from "../langfuse/rerank-prompt"

const captured: LangfuseScore[] = []

export function createContractFakeLangfuseProvider(): LangfuseProvider {
  return {
    name: "contract-fake",
    prompts: {
      get(name, sourceLabels = []) {
        const prompt = bundledPrompt(name)
        if (
          (name === "rfq/extract" || name === "rfq/rerank") &&
          sourceLabels.some((label) =>
            label.includes("trigger-prompt-incompatible")
          )
        ) {
          const schema = z
            .object({ required: z.array(z.string()) })
            .passthrough()
            .parse(prompt.config.response_format)
          schema.required = schema.required.filter((field) =>
            name === "rfq/extract" ? field !== "customer" : field !== "ranked"
          )
          prompt.config.response_format = z.json().parse(schema)
          prompt.version = 999
          prompt.isFallback = false
        }
        return Promise.resolve(
          name === "rfq/extract"
            ? compatibleExtractionPrompt(prompt)
            : compatibleRerankPrompt(prompt)
        )
      },
    },
    scores: {
      write(score) {
        const previous = captured.findIndex((entry) => entry.id === score.id)
        if (previous === -1) captured.push(structuredClone(score))
        else {
          const replacement = structuredClone(score)
          if (
            replacement.comment === undefined &&
            captured[previous].comment !== undefined
          ) {
            replacement.comment = captured[previous].comment
          }
          captured[previous] = replacement
        }
        return Promise.resolve()
      },
    },
  }
}

export function capturedLangfuseScores(): LangfuseScore[] {
  return structuredClone(captured)
}

export function resetCapturedLangfuseScores(): void {
  captured.length = 0
}
