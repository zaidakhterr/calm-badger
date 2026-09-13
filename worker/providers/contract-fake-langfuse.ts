import type { LangfuseProvider, LangfuseScore } from "../langfuse/contract"
import { bundledPrompt } from "../langfuse/fallbacks"

const captured: LangfuseScore[] = []

export function createContractFakeLangfuseProvider(): LangfuseProvider {
  return {
    name: "contract-fake",
    prompts: { get: (name) => Promise.resolve(bundledPrompt(name)) },
    scores: {
      write(score) {
        const previous = captured.findIndex((entry) => entry.id === score.id)
        if (previous === -1) captured.push(structuredClone(score))
        else captured[previous] = structuredClone(score)
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
