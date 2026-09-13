import { LangfuseClient } from "@langfuse/client"

import type { AppConfig } from "../env"
import {
  LANGFUSE_PROMPT_SCHEMA,
  type LangfuseProvider,
} from "../langfuse/contract"
import { bundledPrompt } from "../langfuse/fallbacks"

import { createContractFakeLangfuseProvider } from "./contract-fake-langfuse"

/** Configuration is parsed once per isolate. Its SDK client shares that lifetime. */
const providers = new WeakMap<AppConfig, LangfuseProvider>()

const disabled: LangfuseProvider = {
  name: "none",
  prompts: { get: (name) => Promise.resolve(bundledPrompt(name)) },
  scores: { write: () => Promise.resolve() },
}

export function selectLangfuseProvider(config: AppConfig): LangfuseProvider {
  const cached = providers.get(config)
  if (cached) return cached

  const target = config.langfuse
  if (target.provider === "none") return disabled
  if (target.provider === "contract-fake") {
    const fake = createContractFakeLangfuseProvider()
    providers.set(config, fake)
    return fake
  }

  const client = new LangfuseClient({
    publicKey: target.publicKey,
    secretKey: target.secretKey,
    baseUrl: target.baseUrl,
    timeout: 5,
  })
  const provider: LangfuseProvider = {
    name: "langfuse",
    prompts: {
      async get(name) {
        try {
          const prompt = await client.prompt.get(name, {
            type: "chat",
            label: config.appEnv === "production" ? "production" : "latest",
            cacheTtlSeconds: config.appEnv === "production" ? 60 : 0,
            maxRetries: 0,
            fetchTimeoutMs: 3000,
          })
          const parsed = LANGFUSE_PROMPT_SCHEMA.safeParse(prompt)
          if (parsed.success && parsed.data.name === name) return parsed.data
        } catch {
          // Never log an SDK error: it can carry request or response content.
        }
        console.warn(
          JSON.stringify({ event: "langfuse_prompt_unavailable", name })
        )
        return bundledPrompt(name)
      },
    },
    scores: {
      async write(score) {
        try {
          await client.api.scores.create(
            { ...score, dataType: "BOOLEAN", environment: config.appEnv },
            { maxRetries: 0, timeoutInSeconds: 5 }
          )
        } catch {
          throw new Error("Langfuse score write failed")
        }
      },
    },
  }
  providers.set(config, provider)
  return provider
}
