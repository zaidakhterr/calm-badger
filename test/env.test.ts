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
  EXTRACTION_PROVIDER: "openrouter",
  RERANK_PROVIDER: "openrouter",
  REVIEW_WINDOW_SECONDS_CURATED: "604800",
  REVIEW_WINDOW_SECONDS_CUSTOM: "86400",
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

    // Blank secrets are not configured secrets, and say so in one way.
    expect(config.mistralApiKey).toBeNull()
    expect(config.openRouterApiKey).toBeNull()
    expect(config.rateLimitSalt).toBeNull()
  })

  it("reads windows as numbers", () => {
    const config = APP_CONFIG_SCHEMA.parse(EXAMPLE_VARIABLES)

    expect(config.reviewWindowSecondsCurated).toBe(604800)
    expect(config.reviewWindowSecondsCustom).toBe(86400)
  })

  it("keeps defaults for malformed windows", () => {
    const config = APP_CONFIG_SCHEMA.parse(
      exampleWith({
        REVIEW_WINDOW_SECONDS_CUSTOM: "0",
      })
    )

    expect(config.reviewWindowSecondsCustom).toBe(86400)
  })

  it("defaults every optional key when nothing is configured", () => {
    const config = APP_CONFIG_SCHEMA.parse({})

    expect(config.appEnv).toBe("development")
    expect(config.ocrProvider).toBe("mistral")
    expect(config.extractionProvider).toBe("openrouter")
    expect(config.rerankProvider).toBe("openrouter")
    expect(config.mistralOcrModel).toBe("mistral-ocr-latest")
    expect(config.reviewWindowSecondsCurated).toBe(604800)
    expect(config.analytics).toEqual({ provider: "none", reason: "disabled" })
  })

  it("refuses a contract fake in production", () => {
    for (const variable of [
      "OCR_PROVIDER",
      "EXTRACTION_PROVIDER",
      "RERANK_PROVIDER",
      "ANALYTICS_PROVIDER",
      "LANGFUSE_PROVIDER",
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
    expect(config.langfuse).toEqual({ provider: "contract-fake" })
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

describe("Langfuse provider configuration", () => {
  const credentials = {
    LANGFUSE_PUBLIC_KEY: "test-public",
    LANGFUSE_SECRET_KEY: "test-secret",
    LANGFUSE_BASE_URL: "https://langfuse.example.test/",
  }

  it("defaults to none and keeps tracing independent of prompt and score selection", () => {
    expect(APP_CONFIG_SCHEMA.parse({}).langfuse).toEqual({ provider: "none" })
    const config = APP_CONFIG_SCHEMA.parse({
      ...credentials,
      RATE_LIMIT_SALT: "salt",
      LANGFUSE_PROVIDER: "none",
    })
    expect(config.langfuse).toEqual({ provider: "none" })
    expect(config.tracing.provider).toBe("langfuse")
  })

  it("requires all three credentials for the live provider in every environment", () => {
    for (const appEnv of ["development", "production"]) {
      for (const variable of Object.keys(credentials)) {
        expect(() =>
          APP_CONFIG_SCHEMA.parse({
            ...credentials,
            APP_ENV: appEnv,
            LANGFUSE_PROVIDER: "langfuse",
            [variable]: "",
          })
        ).toThrow(/Required when LANGFUSE_PROVIDER is langfuse/)
      }
    }
    expect(
      APP_CONFIG_SCHEMA.parse({
        ...credentials,
        RATE_LIMIT_SALT: "salt",
        LANGFUSE_PROVIDER: "langfuse",
      }).langfuse
    ).toEqual({
      provider: "langfuse",
      publicKey: "test-public",
      secretKey: "test-secret",
      baseUrl: "https://langfuse.example.test",
    })
  })

  it("requires the salt once tracing is configured", () => {
    expect(() => APP_CONFIG_SCHEMA.parse(credentials)).toThrow(
      /Required when Langfuse tracing is configured/
    )
    expect(
      APP_CONFIG_SCHEMA.parse({ ...credentials, RATE_LIMIT_SALT: "salt" })
        .rateLimitSalt
    ).toBe("salt")
  })

  it("refuses an unsupported provider name", () => {
    expect(() =>
      APP_CONFIG_SCHEMA.parse({ LANGFUSE_PROVIDER: "langfus" })
    ).toThrow()
  })
})
