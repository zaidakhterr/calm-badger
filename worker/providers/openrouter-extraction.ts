/**
 * Live structured-extraction client: the Vercel AI SDK over OpenRouter.
 *
 * Shape follows the documented APIs. `createOpenRouter({ apiKey })` builds the
 * provider, `openrouter.chat(model, …)` builds the language model, and
 * `generateText({ …, output: Output.object({ schema }) })` asks for a
 * schema-constrained response — the OpenRouter provider forwards the schema as
 * a strict `response_format.json_schema` payload. `usage: { include: true }`
 * turns on OpenRouter usage accounting, which reports the credits spent under
 * `providerMetadata.openrouter.usage`.
 *
 * OpenRouter receives the original JSON Schema without a conversion round trip.
 * The AI SDK parses JSON, but the workflow owns validation: raw text is returned,
 * and the workflow step performs the single repair attempt, the Zod check, and
 * the business checks. When the SDK cannot parse the response at all it raises
 * `NoObjectGeneratedError`, which still carries the generated text, so that
 * response follows exactly the same validation path as a well-formed one.
 *
 * What the SDK hands back is still a provider response, so the slice this
 * client consumes — text, finish reason, usage, and OpenRouter's own usage
 * accounting — is parsed with `openrouter-response.ts`'s schema. A result that
 * does not fit becomes an `ExtractionProviderError` rather than an extraction
 * of empty text. `requestFetch` is injectable for exactly the same reason the
 * OCR client's is: so that contract can be tested without a network.
 *
 * `maxRetries: 0` is set explicitly. The AI SDK retries twice by default, which
 * would turn one failing extraction into three paid calls and three times the
 * latency; this demo has no retry story, so a failure is reported once.
 *
 * The API key comes from the `OPENROUTER_API_KEY` secret binding. It is never
 * logged, persisted, or included in stored evidence. The shared renderer lets
 * the workflow store the exact system and user messages without touching the
 * provider request headers.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
} from "ai"

import type { AppConfig } from "../env"

import {
  ExtractionProviderError,
  renderExtractionModelInput,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResult,
} from "./extraction"
import {
  OPENROUTER_RESULT_SCHEMA,
  readReportedCostUsd,
  readTokenUsage,
} from "./openrouter-response"

const PROVIDER = "openrouter"
const REQUEST_TIMEOUT_MS = 60_000

const UNRECOGNISED_RESPONSE =
  "The extraction model returned a response in an unrecognised shape."

export function createOpenRouterExtractionProvider(
  config: AppConfig,
  requestFetch: typeof fetch = fetch
): ExtractionProvider {
  return {
    name: PROVIDER,

    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      const { model, temperature, max_tokens } = request.prompt.config
      const apiKey = config.openRouterApiKey

      if (!apiKey) {
        throw new ExtractionProviderError(
          PROVIDER,
          "The extraction model is not configured for this deployment."
        )
      }

      const openrouter = createOpenRouter({ apiKey, fetch: requestFetch })
      const languageModel = openrouter.chat(model, {
        usage: { include: true },
      })
      const modelInput = renderExtractionModelInput(request)

      const startedAt = Date.now()

      try {
        const generated = await generateText({
          model: languageModel,
          system: modelInput.system,
          prompt: modelInput.user,
          output: Output.object({
            schema: jsonSchema(request.prompt.config.response_format),
            name: request.schemaName,
            description: request.schemaDescription,
          }),
          temperature,
          maxOutputTokens: max_tokens,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          // Names the generation in the trace. Which trace, if any, is the
          // caller's context; this client never learns it.
          runtimeContext: {
            langfusePrompt: {
              name: request.prompt.prompt.name,
              version: request.prompt.prompt.version,
              isFallback: request.prompt.prompt.isFallback,
            },
          },
          telemetry: {
            functionId: "extract-rfq",
            includeRuntimeContext: { langfusePrompt: true },
          },
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
          throw new ExtractionProviderError(PROVIDER, UNRECOGNISED_RESPONSE)
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
        if (error instanceof ExtractionProviderError) throw error

        if (NoObjectGeneratedError.isInstance(error)) {
          // Unparseable output is a validation outcome, not a transport
          // failure: hand the text on so the step's single repair attempt and
          // the schema decide whether the run can continue.
          const parsed = OPENROUTER_RESULT_SCHEMA.safeParse({
            text: error.text ?? "",
            finishReason: error.finishReason ?? "error",
            usage: error.usage,
            providerMetadata: null,
          })

          if (!parsed.success) {
            throw new ExtractionProviderError(PROVIDER, UNRECOGNISED_RESPONSE)
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

        throw new ExtractionProviderError(
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
    return `The extraction model rejected the request (${status}).`
  }

  if (timedOut) {
    return "The extraction model did not respond in time."
  }

  return "The extraction model could not be reached."
}
