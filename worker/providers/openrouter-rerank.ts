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
 * The model comes from `OPENROUTER_RERANK_MODEL`, which is configured
 * independently of the extraction model. The API key comes from the
 * `OPENROUTER_API_KEY` secret binding; it is never logged, never persisted, and
 * never included in stored evidence. Prompts are likewise never persisted.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, NoObjectGeneratedError, Output } from "ai"

import {
  RerankProviderError,
  type RerankProvider,
  type RerankRequest,
  type RerankResult,
  type RerankUsage,
} from "./rerank"

const PROVIDER = "openrouter"
const REQUEST_TIMEOUT_MS = 45_000
const MAX_OUTPUT_TOKENS = 1_500

export function createOpenRouterRerankProvider(env: Env): RerankProvider {
  const model = env.OPENROUTER_RERANK_MODEL

  return {
    name: PROVIDER,
    model,

    async rerank(request: RerankRequest): Promise<RerankResult> {
      const apiKey = env.OPENROUTER_API_KEY?.trim()

      if (!apiKey) {
        throw new RerankProviderError(
          PROVIDER,
          "The reranking model is not configured for this deployment."
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
          prompt: renderRequest(request),
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
          return {
            model,
            text: error.text ?? "",
            usage: readUsage(error.usage),
            latencyMs: Date.now() - startedAt,
            finishReason: error.finishReason ?? "error",
            reportedCostUsd: null,
          }
        }

        throw new RerankProviderError(
          PROVIDER,
          describeFailure(error),
          readStatus(error)
        )
      }
    },
  }
}

/**
 * The user prompt: the requested line as the request wrote it, and the
 * shortlist retrieval already bounded. Nothing else is sent — no other
 * catalogue rows, no customer record, and no expected outcome.
 */
function renderRequest(request: RerankRequest): string {
  const candidates = request.candidates.map((candidate, index) =>
    [
      `${index + 1}. sku: ${candidate.sku}`,
      `   name: ${candidate.name}`,
      `   description: ${candidate.description}`,
      `   category: ${candidate.category}; manufacturer: ${candidate.manufacturer}; unit: ${candidate.unit}`,
      candidate.knownAs.length > 0
        ? `   also known as: ${candidate.knownAs.join("; ")}`
        : null,
    ]
      .filter((part) => part !== null)
      .join("\n")
  )

  return [
    `Requested line: ${request.reference}`,
    request.description && request.description !== request.reference
      ? `Requested description: ${request.description}`
      : null,
    "",
    "Candidate products:",
    ...candidates,
  ]
    .filter((part) => part !== null)
    .join("\n")
}

function readUsage(usage: unknown): RerankUsage {
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
    return `The reranking model rejected the request (${status}).`
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return "The reranking model did not respond in time."
  }

  return "The reranking model could not be reached."
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
