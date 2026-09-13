import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"

import { APP_CONFIG_SCHEMA, readConfig } from "../worker/env"
import type { LangfuseScore } from "../worker/langfuse/contract"
import { bundledPrompt } from "../worker/langfuse/fallbacks"
import { RERANK_INSTRUCTION } from "../worker/product-matching"
import {
  capturedLangfuseScores,
  resetCapturedLangfuseScores,
} from "../worker/providers/contract-fake-langfuse"
import { selectLangfuseProvider } from "../worker/providers/langfuse"
import { RFQ_EXTRACTION_INSTRUCTION } from "../worker/rfq-extraction"

const score: LangfuseScore = {
  id: "score-1",
  traceId: "trace-1",
  observationId: "observation-1",
  name: "owner-line-thumbs",
  value: 1,
  comment: "Correct product",
}

describe("the Langfuse provider contract", () => {
  beforeEach(resetCapturedLangfuseScores)

  it("selects the offline test provider and serves both bundled prompts", async () => {
    const provider = selectLangfuseProvider(readConfig(env))
    expect(provider.name).toBe("contract-fake")
    expect(selectLangfuseProvider(readConfig(env))).toBe(provider)

    for (const name of ["rfq/extract", "rfq/rerank"] as const) {
      expect(await provider.prompts.get(name)).toEqual(bundledPrompt(name))
    }
    expect((await provider.prompts.get("rfq/extract")).prompt[0].content).toBe(
      RFQ_EXTRACTION_INSTRUCTION
    )
    expect((await provider.prompts.get("rfq/rerank")).prompt[0].content).toBe(
      RERANK_INSTRUCTION
    )
  })

  it("keeps each returned fallback independent of caller mutations", async () => {
    const provider = selectLangfuseProvider(readConfig(env))
    const prompt = await provider.prompts.get("rfq/extract")
    prompt.prompt[0].content = "changed"
    prompt.config.model = "changed"
    expect(await provider.prompts.get("rfq/extract")).toEqual(
      bundledPrompt("rfq/extract")
    )
  })

  it("records score writes across selections and replaces the same score id", async () => {
    const provider = selectLangfuseProvider(readConfig(env))
    await provider.scores.write(score)
    expect(capturedLangfuseScores()).toEqual([score])
    const corrected = {
      ...score,
      value: 0,
      comment: "Wrong product",
    } satisfies LangfuseScore
    await selectLangfuseProvider(readConfig(env)).scores.write(corrected)
    expect(capturedLangfuseScores()).toEqual([corrected])
    capturedLangfuseScores()[0].comment = "changed"
    expect(capturedLangfuseScores()).toEqual([corrected])
    resetCapturedLangfuseScores()
    expect(capturedLangfuseScores()).toEqual([])
  })

  it("uses local fallbacks and writes no scores when disabled", async () => {
    const provider = selectLangfuseProvider(
      APP_CONFIG_SCHEMA.parse({ LANGFUSE_PROVIDER: "none" })
    )
    expect(provider.name).toBe("none")
    expect(await provider.prompts.get("rfq/rerank")).toEqual(
      bundledPrompt("rfq/rerank")
    )
    await provider.scores.write(score)
    expect(capturedLangfuseScores()).toEqual([])
  })

  it("reuses the live provider for the isolate configuration without starting network work", () => {
    const config = APP_CONFIG_SCHEMA.parse({
      LANGFUSE_PROVIDER: "langfuse",
      LANGFUSE_PUBLIC_KEY: "test-public",
      LANGFUSE_SECRET_KEY: "test-secret",
      LANGFUSE_BASE_URL: "https://langfuse.example.test",
    })
    const provider = selectLangfuseProvider(config)
    expect(provider.name).toBe("langfuse")
    expect(selectLangfuseProvider(config)).toBe(provider)
  })
})
