/** A configured project shared by tracing, prompts, and scores. */
export type LangfuseTarget = {
  provider: "langfuse"
  publicKey: string
  secretKey: string
  baseUrl: string
}

export type TracingTarget =
  LangfuseTarget | { provider: "none"; reason: "unconfigured" }

/** Tracing remains independent of the prompt and score provider selection. */
export function tracingTarget(
  publicKey: string | null,
  secretKey: string | null,
  baseUrl: string | null
): TracingTarget {
  if (publicKey === null || secretKey === null || baseUrl === null) {
    return { provider: "none", reason: "unconfigured" }
  }
  return {
    provider: "langfuse",
    publicKey,
    secretKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
  }
}

export type LangfuseProviderTarget =
  LangfuseTarget | { provider: "none" } | { provider: "contract-fake" }

/** Credential requirements and production refusal are checked by AppConfig. */
export function langfuseTarget(
  provider: "langfuse" | "contract-fake" | "none",
  tracing: TracingTarget
): LangfuseProviderTarget {
  if (provider === "none") return { provider: "none" }
  if (provider === "contract-fake") return { provider: "contract-fake" }
  return tracing
}
