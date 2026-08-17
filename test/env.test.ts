import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { APP_CONFIG_SCHEMA, readConfig } from "../worker/env"
import worker from "../worker/index"

/**
 * What a deployment is allowed to be configured as.
 *
 * The schema is the only place that decides what a variable means, so this
 * suite drives it directly: the shipped example values parse, a contract fake
 * in production does not, numbers arrive as numbers, and absent keys take the
 * documented defaults instead of leaking blanks into the run.
 */

/**
 * `wrangler.jsonc` vars overlaid with `.dev.vars.example`: what a fresh local
 * checkout actually runs with, secrets included as the blanks they are.
 */
const EXAMPLE_VARIABLES = {
  APP_ENV: "development",
  OCR_PROVIDER: "mistral",
  MISTRAL_OCR_MODEL: "mistral-ocr-latest",
  OCR_COST_PER_1000_PAGES_USD: "1",
  EXTRACTION_PROVIDER: "openrouter",
  OPENROUTER_EXTRACTION_MODEL: "openai/gpt-5.6-luna",
  RERANK_PROVIDER: "openrouter",
  OPENROUTER_RERANK_MODEL: "openai/gpt-5.6-luna",
  MATCH_WINNER_STRENGTH: "0.55",
  MATCH_WINNER_GAP: "0.12",
  REVIEW_WINDOW_SECONDS_CURATED: "604800",
  REVIEW_WINDOW_SECONDS_CUSTOM: "86400",
  OPENROUTER_COST_PER_1M_INPUT_TOKENS_USD: "1.25",
  OPENROUTER_COST_PER_1M_OUTPUT_TOKENS_USD: "10",
  ANALYTICS_PROVIDER: "posthog",
  POSTHOG_HOST: "https://eu.i.posthog.com",
  MISTRAL_API_KEY: "",
  OPENROUTER_API_KEY: "",
  POSTHOG_API_KEY: "",
  RATE_LIMIT_SALT: "",
}

function exampleWith(overrides: Record<string, string>) {
  return { ...EXAMPLE_VARIABLES, ...overrides }
}

/** The isolate's own bindings with variables overridden, as in every suite. */
function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides }
}

describe("the configuration schema", () => {
  it("accepts the values a fresh checkout runs with", () => {
    const config = APP_CONFIG_SCHEMA.parse(EXAMPLE_VARIABLES)

    expect(config.appEnv).toBe("development")
    expect(config.ocrProvider).toBe("mistral")
    expect(config.extractionProvider).toBe("openrouter")
    expect(config.rerankProvider).toBe("openrouter")
    expect(config.mistralOcrModel).toBe("mistral-ocr-latest")
    expect(config.extractionModel).toBe("openai/gpt-5.6-luna")

    // Blank secrets are not configured secrets, and say so in one way.
    expect(config.mistralApiKey).toBeNull()
    expect(config.openRouterApiKey).toBeNull()
    expect(config.rateLimitSalt).toBeNull()
  })

  it("reads costs, thresholds, and windows as numbers", () => {
    const config = APP_CONFIG_SCHEMA.parse(EXAMPLE_VARIABLES)

    expect(config.ocrCostPer1000PagesUsd).toBe(1)
    expect(config.openRouterCostPer1MInputTokensUsd).toBe(1.25)
    expect(config.openRouterCostPer1MOutputTokensUsd).toBe(10)
    expect(config.matchWinnerStrength).toBe(0.55)
    expect(config.matchWinnerGap).toBe(0.12)
    expect(config.reviewWindowSecondsCurated).toBe(604800)
    expect(config.reviewWindowSecondsCustom).toBe(86400)
  })

  it("reports an unknown price rather than zero, and keeps demo defaults", () => {
    const config = APP_CONFIG_SCHEMA.parse(
      exampleWith({
        OCR_COST_PER_1000_PAGES_USD: "",
        OPENROUTER_COST_PER_1M_INPUT_TOKENS_USD: "free",
        OPENROUTER_COST_PER_1M_OUTPUT_TOKENS_USD: "-1",
        MATCH_WINNER_STRENGTH: "strict",
        MATCH_WINNER_GAP: "-2",
        REVIEW_WINDOW_SECONDS_CUSTOM: "0",
      })
    )

    expect(config.ocrCostPer1000PagesUsd).toBeNull()
    expect(config.openRouterCostPer1MInputTokensUsd).toBeNull()
    expect(config.openRouterCostPer1MOutputTokensUsd).toBeNull()
    expect(config.matchWinnerStrength).toBe(0.55)
    expect(config.matchWinnerGap).toBe(0.12)
    expect(config.reviewWindowSecondsCustom).toBe(86400)
  })

  it("defaults every optional key when nothing is configured", () => {
    const config = APP_CONFIG_SCHEMA.parse({})

    expect(config.appEnv).toBe("development")
    expect(config.ocrProvider).toBe("mistral")
    expect(config.extractionProvider).toBe("openrouter")
    expect(config.rerankProvider).toBe("openrouter")
    expect(config.mistralOcrModel).toBe("mistral-ocr-latest")
    expect(config.rerankModel).toBe("openai/gpt-5.6-luna")
    expect(config.matchWinnerStrength).toBe(0.55)
    expect(config.reviewWindowSecondsCurated).toBe(604800)
    expect(config.ocrCostPer1000PagesUsd).toBeNull()
    expect(config.analytics).toEqual({ provider: "none", reason: "disabled" })
  })

  it("refuses a contract fake in production", () => {
    for (const variable of [
      "OCR_PROVIDER",
      "EXTRACTION_PROVIDER",
      "RERANK_PROVIDER",
      "ANALYTICS_PROVIDER",
    ]) {
      expect(() =>
        APP_CONFIG_SCHEMA.parse(
          exampleWith({ APP_ENV: "production", [variable]: "contract-fake" })
        )
      ).toThrow(/not allowed in production/)
    }

    // The same fakes are exactly what a test or a fixture run selects.
    expect(
      APP_CONFIG_SCHEMA.parse(
        exampleWith({ APP_ENV: "test", OCR_PROVIDER: "contract-fake" })
      ).ocrProvider
    ).toBe("contract-fake")
  })

  it("refuses a provider name nothing implements", () => {
    expect(() =>
      APP_CONFIG_SCHEMA.parse(exampleWith({ OCR_PROVIDER: "mistrel" }))
    ).toThrow()

    expect(() =>
      APP_CONFIG_SCHEMA.parse(exampleWith({ RERANK_PROVIDER: "openroutr" }))
    ).toThrow()
  })

  it("cannot resolve to PostHog without a project key", () => {
    // A fork deploying without a key measures nothing; it does not break.
    expect(
      APP_CONFIG_SCHEMA.parse(
        exampleWith({ APP_ENV: "production", POSTHOG_API_KEY: "" })
      ).analytics
    ).toEqual({ provider: "none", reason: "unconfigured" })

    // A key outside production stays configured and unused.
    expect(
      APP_CONFIG_SCHEMA.parse(
        exampleWith({ POSTHOG_API_KEY: "phc-a-real-looking-project-key" })
      ).analytics
    ).toEqual({ provider: "none", reason: "outside_production" })

    expect(
      APP_CONFIG_SCHEMA.parse(
        exampleWith({
          APP_ENV: "production",
          POSTHOG_API_KEY: "phc-a-real-looking-project-key",
          POSTHOG_HOST: "https://eu.i.posthog.com/",
        })
      ).analytics
    ).toEqual({
      provider: "posthog",
      host: "https://eu.i.posthog.com",
      apiKey: "phc-a-real-looking-project-key",
    })
  })
})

describe("reading configuration from the binding object", () => {
  it("parses the test isolate's own environment", () => {
    const config = readConfig(env)

    expect(config.appEnv).toBe("test")
    expect(config.ocrProvider).toBe("contract-fake")
    expect(config.analytics).toEqual({ provider: "contract-fake" })
    expect(config.rateLimitSalt).toBe("test-rate-limit-salt")
  })

  it("fails a misconfigured deployment's first request rather than a run", async () => {
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      new Request("https://example.test/api/health"),
      envWith({ OCR_PROVIDER: "contract-fake", APP_ENV: "production" }),
      ctx
    )
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(500)

    // The reviewer-facing body says nothing about the deployment: the variables
    // that are wrong are in the structured log line, keyed by request id.
    const body = z
      .object({ error: z.string(), requestId: z.string().min(1) })
      .parse(await response.json())

    expect(body.error).toBe("Internal server error")
  })

  it("parses once per binding object, and again for an override", () => {
    expect(readConfig(env)).toBe(readConfig(env))

    const overridden = envWith({ OCR_PROVIDER: "mistral" })

    expect(readConfig(overridden)).toBe(readConfig(overridden))
    expect(readConfig(overridden)).not.toBe(readConfig(env))
    expect(readConfig(overridden).ocrProvider).toBe("mistral")
  })
})
