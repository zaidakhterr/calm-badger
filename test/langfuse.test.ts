import { z } from "zod"
import { compatibleExtractionPrompt } from "../worker/langfuse/extraction-prompt"
import {
  RFQ_EXTRACTION_CONTRACT,
  RFQ_CUSTOMER_SCHEMA,
  RFQ_SOURCE_SCHEMA,
  RFQ_DEADLINE_SCHEMA,
} from "../worker/rfq-extraction"
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

describe("extraction prompt compatibility", () => {
  it.each([
    RFQ_EXTRACTION_CONTRACT.omit({ customer: true }),
    RFQ_EXTRACTION_CONTRACT.extend({
      customer: RFQ_CUSTOMER_SCHEMA.omit({
        contactEmail: true,
      }),
    }),
    RFQ_EXTRACTION_CONTRACT.extend({
      customer: RFQ_CUSTOMER_SCHEMA.partial({
        contactEmail: true,
      }),
    }),
    RFQ_EXTRACTION_CONTRACT.extend({
      lineItems: z.array(z.object({ reference: z.string() })),
    }),
    RFQ_EXTRACTION_CONTRACT.extend({
      source: RFQ_SOURCE_SCHEMA.omit({ channel: true }),
    }),
    RFQ_EXTRACTION_CONTRACT.extend({
      deadline: RFQ_DEADLINE_SCHEMA.omit({ date: true }),
    }),
  ])("refuses missing required fields at every consumed depth", (schema) => {
    const prompt = bundledPrompt("rfq/extract")
    prompt.version = 42
    prompt.isFallback = false
    prompt.config.response_format = z.json().parse(z.toJSONSchema(schema))
    expect(compatibleExtractionPrompt(prompt)).toEqual(
      bundledPrompt("rfq/extract")
    )
  })

  it("accepts additional fields, descriptions, and tighter enums", () => {
    const prompt = bundledPrompt("rfq/extract")
    prompt.config.response_format = z.json().parse(
      z.toJSONSchema(
        RFQ_EXTRACTION_CONTRACT.extend({
          authorNote: z.string().describe("An author-managed field"),
          source: RFQ_SOURCE_SCHEMA.extend({
            channel: z.literal("email"),
          }),
        })
      )
    )
    expect(compatibleExtractionPrompt(prompt)).toEqual(prompt)
  })

  it("rejects malformed prompt settings before the paid call", () => {
    const prompt = bundledPrompt("rfq/extract")
    prompt.config.max_tokens = -1
    expect(compatibleExtractionPrompt(prompt)).toEqual(
      bundledPrompt("rfq/extract")
    )
  })

  it("uses the same fallback guard for a fake incompatible source label", async () => {
    expect(
      await selectLangfuseProvider(readConfig(env)).prompts.get("rfq/extract", [
        "trigger-prompt-incompatible.pdf",
      ])
    ).toEqual(bundledPrompt("rfq/extract"))
  })
})

it("refuses JSON Schema constraints the converter cannot enforce", () => {
  const prompt = bundledPrompt("rfq/extract")
  prompt.config.response_format = {
    ...z.record(z.string(), z.json()).parse(prompt.config.response_format),
    maxProperties: 3,
  }
  expect(compatibleExtractionPrompt(prompt)).toEqual(
    bundledPrompt("rfq/extract")
  )
})

it("refuses defaults that would fill a required field missing from model output", () => {
  const prompt = bundledPrompt("rfq/extract")
  const schema = z
    .record(z.string(), z.json())
    .parse(prompt.config.response_format)
  const properties = z.record(z.string(), z.json()).parse(schema.properties)
  const customer = z.record(z.string(), z.json()).parse(properties.customer)
  const fields = z.record(z.string(), z.json()).parse(customer.properties)
  fields.contactEmail = {
    ...z.record(z.string(), z.json()).parse(fields.contactEmail),
    default: null,
  }
  customer.properties = fields
  properties.customer = customer
  schema.properties = properties
  prompt.config.response_format = schema
  expect(compatibleExtractionPrompt(prompt)).toEqual(
    bundledPrompt("rfq/extract")
  )
})
