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
 * The AI SDK parses the response against the schema itself. That parse is not
 * treated as authoritative here: the model's raw text is returned either way,
 * and the workflow step performs the single repair attempt, the Zod check, and
 * the business checks. When the SDK cannot parse the response at all it raises
 * `NoObjectGeneratedError`, which still carries the generated text, so that
 * response follows exactly the same validation path as a well-formed one.
 *
 * `maxRetries: 0` is set explicitly. The AI SDK retries twice by default, which
 * would turn one failing extraction into three paid calls and three times the
 * latency; this demo has no retry story, so a failure is reported once.
 *
 * The API key comes from the `OPENROUTER_API_KEY` secret binding. It is never
 * logged, never persisted, and never included in stored evidence. Prompts are
 * likewise never persisted or returned.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, NoObjectGeneratedError, Output } from "ai"

import {
  ExtractionProviderError,
  type ExtractionDocument,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResult,
  type ExtractionUsage,
} from "./extraction"

const PROVIDER = "openrouter"
const REQUEST_TIMEOUT_MS = 60_000
const MAX_OUTPUT_TOKENS = 4_000

export function createOpenRouterExtractionProvider(
  env: Env
): ExtractionProvider {
  const model = env.OPENROUTER_EXTRACTION_MODEL

  return {
    name: PROVIDER,
    model,

    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      const apiKey = env.OPENROUTER_API_KEY?.trim()

      if (!apiKey) {
        throw new ExtractionProviderError(
          PROVIDER,
          "The extraction model is not configured for this deployment."
        )
      }

      const openrouter = createOpenRouter({ apiKey })
      const languageModel = openrouter.chat(model, {
        usage: { include: true },
      })

      const startedAt = Date.now()

      try {
        const result = await generateText({
          model: languageModel,
          system: request.instruction,
          prompt: renderDocuments(request.documents),
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

        return {
          model,
          text: result.text,
          usage: readUsage(result.usage),
          latencyMs: Date.now() - startedAt,
          finishReason: result.finishReason,
          reportedCostUsd: readReportedCost(result.providerMetadata),
        }
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          // Unparseable output is a validation outcome, not a transport
          // failure: hand the text on so the step's single repair attempt and
          // the schema decide whether the run can continue.
          return {
            model,
            text: error.text ?? "",
            usage: readUsage(error.usage),
            latencyMs: Date.now() - startedAt,
            finishReason: error.finishReason ?? "error",
            reportedCostUsd: null,
          }
        }

        throw new ExtractionProviderError(
          PROVIDER,
          describeFailure(error),
          readStatus(error)
        )
      }
    },
  }
}

/**
 * The user prompt: the text already read from the request's own documents,
 * with its provenance. Nothing else is sent — no catalogue, no expected
 * outcome, and no interface copy.
 */
function renderDocuments(documents: ExtractionDocument[]): string {
  const rendered = documents.map((document) => {
    return [
      `--- source: ${document.label} (${document.kind}), page ${document.pageNumber} ---`,
      document.markdown,
    ].join("\n")
  })

  return rendered.join("\n\n")
}

function readUsage(usage: unknown): ExtractionUsage {
  const value = (usage ?? {}) as Record<string, unknown>
  const inputTokens = readInteger(value.inputTokens) ?? 0
  const outputTokens = readInteger(value.outputTokens) ?? 0

  return {
    inputTokens,
    outputTokens,
    totalTokens: readInteger(value.totalTokens) ?? inputTokens + outputTokens,
  }
}

/** OpenRouter usage accounting reports credits under `openrouter.usage.cost`. */
function readReportedCost(metadata: unknown): number | null {
  if (typeof metadata !== "object" || metadata === null) return null

  const openrouter = (metadata as Record<string, unknown>).openrouter
  if (typeof openrouter !== "object" || openrouter === null) return null

  const usage = (openrouter as Record<string, unknown>).usage
  if (typeof usage !== "object" || usage === null) return null

  const cost = (usage as Record<string, unknown>).cost
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null
}

/**
 * Provider failures are reduced to a short sentence. The error cause can carry
 * the request body and headers, so nothing from it is propagated beyond a
 * status code.
 */
function describeFailure(error: unknown): string {
  const status = readStatus(error)

  if (status !== null) {
    return `The extraction model rejected the request (${status}).`
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return "The extraction model did not respond in time."
  }

  return "The extraction model could not be reached."
}

function readStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null

  const status = (error as { statusCode?: unknown }).statusCode
  return typeof status === "number" && Number.isFinite(status) ? status : null
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null
}
