/** Attach OpenRouter's billed cost to the AI SDK model-call generation. */

import { LangfuseOtelSpanAttributes } from "@langfuse/core"
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk"
import { trace } from "@opentelemetry/api"
import { z } from "zod"

const OPENROUTER_COST_RESULT_SCHEMA = z.object({
  providerMetadata: z
    .object({
      openrouter: z
        .object({
          usage: z
            .object({ cost: z.number().nonnegative().finite().nullish() })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
})

/**
 * AI SDK 7 closes the model-call span before `generateText` returns. Wrap the
 * provider call while that span is active, then attach the cost after the SDK
 * has normalized OpenRouter's provider metadata. An absent cost leaves the
 * attribute absent so Langfuse can use its model-table fallback.
 */
export class LangfuseOpenRouterIntegration extends LangfuseVercelAiSdkIntegration {
  override executeLanguageModelCall<T>(parameters: {
    callId: string
    execute: () => PromiseLike<T>
  }): PromiseLike<T> {
    return super.executeLanguageModelCall({
      callId: parameters.callId,
      execute: async () => {
        const result = await parameters.execute()
        const parsed = OPENROUTER_COST_RESULT_SCHEMA.safeParse(result)
        const cost = parsed.success
          ? (parsed.data.providerMetadata?.openrouter?.usage?.cost ?? null)
          : null

        if (cost !== null) {
          trace
            .getActiveSpan()
            ?.setAttribute(
              LangfuseOtelSpanAttributes.OBSERVATION_COST_DETAILS,
              JSON.stringify({ total: cost })
            )
        }

        return result
      },
    })
  }
}
