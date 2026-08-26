/**
 * Live candidate-reranking client: the Vercel AI SDK over OpenRouter.
 *
 * The shape is the extraction client's, for the same documented reasons:
 * `createOpenRouter({ apiKey })` builds the provider, `openrouter.chat(model,
 * …)` builds the language model, and `generateText({ …, output:
 * Output.object({ schema }) })` asks for a schema-constrained response, which
 * the OpenRouter provider forwards as a strict `response_format.json_schema`
 * payload. `usage: { include: true }` turns on usage accounting, which reports
 * spend under `providerMetadata.openrouter.usage`.
 *
 * The model's raw text is returned either way; the workflow step performs the
 * repair attempt, the Zod check, and the integrity check that the chosen SKU
 * was on the shortlist and is an active catalogue product. `NoObjectGenerated
 * Error` still carries the generated text, so an unparseable response follows
 * the same validation path as a well-formed one rather than becoming an opaque
 * transport failure.
 *
 * `maxRetries: 0` is explicit: the SDK retries twice by default, and one
 * reranked line per retry would triple the paid calls for a step that already
 * makes one call per requested line.
 *
 * The slice of the result this client consumes — text, finish reason, usage,
 * and OpenRouter's own usage accounting — is parsed with the schema in
 * `openrouter-response.ts`, which extraction reads the same provider with. A
 * result that does not fit becomes a `RerankProviderError` rather than a
 * ranking of empty text, and `requestFetch` is injectable so that contract can
 * be tested without a network.
 *
 * The model comes from `OPENROUTER_RERANK_MODEL`, which is configured
 * independently of the extraction model. The API key comes from the
 * `OPENROUTER_API_KEY` secret binding; it is never logged, persisted, or
 * included in stored evidence. The shared renderer lets the workflow store the
 * exact system and user messages without touching provider request headers.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { APICallError, generateText, NoObjectGeneratedError, Output } from "ai"

import type { AppConfig } from "../env"

import {
  OPENROUTER_RESULT_SCHEMA,
  readReportedCostUsd,
  readTokenUsage,
} from "./openrouter-response"
import {
  RerankProviderError,
  renderRerankModelInput,
  type RerankProvider,
  type RerankRequest,
  type RerankResult,
} from "./rerank"

const PROVIDER = "openrouter"
const REQUEST_TIMEOUT_MS = 45_000
const MAX_OUTPUT_TOKENS = 1_500

const UNRECOGNISED_RESPONSE =
  "The reranking model returned a response in an unrecognised shape."

export function createOpenRouterRerankProvider(
  config: AppConfig,
  requestFetch: typeof fetch = fetch
): RerankProvider {
  const model = config.rerankModel

  return {
    name: PROVIDER,
    model,

    async rerank(request: RerankRequest): Promise<RerankResult> {
      const apiKey = config.openRouterApiKey

      if (!apiKey) {
        throw new RerankProviderError(
          PROVIDER,
          "The reranking model is not configured for this deployment."
        )
      }

      const openrouter = createOpenRouter({ apiKey, fetch: requestFetch })
      const languageModel = openrouter.chat(model, {
        usage: { include: true },
      })
      const modelInput = renderRerankModelInput(request)

      const startedAt = Date.now()

      try {
        const generated = await generateText({
          model: languageModel,
          system: modelInput.system,
          prompt: modelInput.user,
          output: Output.object({
            schema: request.schema,
            name: request.schemaName,
            description: request.schemaDescription,
          }),
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        // The one boundary this client reads the provider across. A result
        // that does not fit ends the run as any other provider failure does,
        // rather than reaching the workflow as empty text and zero tokens.
        const parsed = OPENROUTER_RESULT_SCHEMA.safeParse({
          text: generated.text,
          finishReason: generated.finishReason,
          usage: generated.usage,
          providerMetadata: generated.providerMetadata,
        })

        if (!parsed.success) {
          throw new RerankProviderError(PROVIDER, UNRECOGNISED_RESPONSE)
        }

        return {
          model,
          text: parsed.data.text,
          usage: readTokenUsage(parsed.data),
          latencyMs: Date.now() - startedAt,
          finishReason: parsed.data.finishReason,
          reportedCostUsd: readReportedCostUsd(parsed.data),
        }
      } catch (error) {
        // A response that did not fit the schema is already this provider's
        // error; describing it again would report it as a transport failure.
        if (error instanceof RerankProviderError) throw error

        if (NoObjectGeneratedError.isInstance(error)) {
          const parsed = OPENROUTER_RESULT_SCHEMA.safeParse({
            text: error.text ?? "",
            finishReason: error.finishReason ?? "error",
            usage: error.usage,
            providerMetadata: null,
          })

          if (!parsed.success) {
            throw new RerankProviderError(PROVIDER, UNRECOGNISED_RESPONSE)
          }

          return {
            model,
            text: parsed.data.text,
            usage: readTokenUsage(parsed.data),
            latencyMs: Date.now() - startedAt,
            finishReason: parsed.data.finishReason,
            reportedCostUsd: null,
          }
        }

        const status = APICallError.isInstance(error)
          ? (error.statusCode ?? null)
          : null
        const timedOut = error instanceof Error && error.name === "TimeoutError"

        throw new RerankProviderError(
          PROVIDER,
          describeFailure(status, timedOut),
          status
        )
      }
    },
  }
}

/**
 * Provider failures are reduced to a short sentence. The error cause can carry
 * the request body and headers, so nothing from it is propagated beyond the
 * status code the SDK's own `APICallError` names.
 */
function describeFailure(status: number | null, timedOut: boolean): string {
  if (status !== null) {
    return `The reranking model rejected the request (${status}).`
  }

  if (timedOut) {
    return "The reranking model did not respond in time."
  }

  return "The reranking model could not be reached."
}
