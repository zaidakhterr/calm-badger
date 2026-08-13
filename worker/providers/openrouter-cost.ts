/**
 * Estimated OpenRouter spend, shared by extraction and reranking.
 *
 * The per-million-token prices are configured variables rather than constants
 * so they can be corrected without a code change; the interface labels the
 * result as an estimate and shows the provider's own figure beside it when the
 * provider reports one.
 *
 * A missing or malformed price yields `null`, not zero. A free call and an
 * uncosted call are different facts, and showing "$0.0000" for a deployment
 * whose prices were never configured would be a quiet lie.
 */

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
}

export function estimateOpenRouterCostUsd(
  env: Env,
  usage: TokenUsage
): number | null {
  const input = readPrice(env.OPENROUTER_COST_PER_1M_INPUT_TOKENS_USD)
  const output = readPrice(env.OPENROUTER_COST_PER_1M_OUTPUT_TOKENS_USD)

  if (input === null || output === null) return null

  const total =
    (usage.inputTokens * input) / 1e6 + (usage.outputTokens * output) / 1e6

  return Math.round(total * 1e6) / 1e6
}

function readPrice(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
