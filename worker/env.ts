/**
 * Typed configuration.
 *
 * `Env` is the Cloudflare binding object: `DB`, `ARTIFACTS`, `RFQ_WORKFLOW`,
 * `ASSETS`, and a set of strings. Everything on it that is a string is parsed
 * here, once, into `AppConfig` — provider names as enums, models as non-empty
 * text, costs and thresholds and windows as numbers, secrets as `string | null`
 * — so that no call site anywhere else reads `env.SOME_VARIABLE` and decides
 * for itself what a blank one means.
 *
 * The invariants a deployment must satisfy live in the schema rather than in
 * the code that consumes it:
 *
 * - a contract fake is refused when `APP_ENV` is production, for every seam
 *   that has one;
 * - an *effective* PostHog target cannot exist without a project key, so the
 *   analytics provider never has to ask whether its key is present;
 * - thresholds are ratios and review windows are positive.
 *
 * Where a bad value has an honest fallback the schema takes it, because that
 * is the behaviour these variables already had: a malformed price yields `null`
 * (an uncosted call and a free call are different facts), and a nonsense
 * threshold or window yields the documented default. Where a bad value has no
 * honest fallback — an unknown provider, a fake in production — parsing fails,
 * and the Worker and the workflow turn that into one clear line rather than a
 * surprise halfway through a run.
 */

import { z } from "zod"

/** The deployed defaults, repeated here so a missing variable is not fatal. */
const DEFAULT_MISTRAL_OCR_MODEL = "mistral-ocr-latest"
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna"
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com"

/**
 * The winner-strength default is the same 0.55 that separates a Medium
 * confidence label from a Review one, so "accepted" and "at least Medium" mean
 * the same thing.
 */
const DEFAULT_WINNER_STRENGTH = 0.55
const DEFAULT_WINNER_GAP = 0.12

/**
 * How long an owner has to decide. The window mirrors the run's own retention,
 * because a review must never outlive the data it decides: custom uploads and
 * everything derived from them are deleted after 24 hours, curated sample runs
 * after seven days. Both are configurable so the expiry path is testable in
 * seconds.
 */
const DEFAULT_WINDOW_SECONDS_CURATED = 7 * 24 * 60 * 60
const DEFAULT_WINDOW_SECONDS_CUSTOM = 24 * 60 * 60

/** Required text with a deployed default. Absent falls back; blank is a fault. */
function text(fallback: string) {
  return z.string().trim().min(1).default(fallback)
}

/**
 * A configured price. Blank, absent, negative, or unparseable yields `null`
 * rather than zero: an estimator that prints "$0.0000" for a deployment whose
 * prices were never configured is telling a quiet lie.
 */
const priceUsd = z
  .string()
  .trim()
  .transform((raw) => Number.parseFloat(raw))
  .refine((value) => Number.isFinite(value) && value >= 0)
  .nullable()
  .catch(null)

/** A demo heuristic between 0 and 1. Nonsense takes the documented default. */
function ratio(fallback: number) {
  return z
    .string()
    .trim()
    .transform((raw) => Number.parseFloat(raw))
    .refine((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    .catch(fallback)
}

/** A positive duration in seconds. Nonsense takes the documented default. */
function seconds(fallback: number) {
  return z
    .string()
    .trim()
    .transform((raw) => Number.parseFloat(raw))
    .refine((value) => Number.isFinite(value) && value > 0)
    .catch(fallback)
}

/** An optional secret. Absent and blank are the same fact: not configured. */
const secret = z.string().trim().min(1).nullable().catch(null)

/** The string half of `Env`, before any invariant across two variables. */
const VARIABLES_SCHEMA = z.object({
  APP_ENV: text("development"),

  OCR_PROVIDER: z.enum(["mistral", "contract-fake"]).default("mistral"),
  MISTRAL_OCR_MODEL: text(DEFAULT_MISTRAL_OCR_MODEL),
  MISTRAL_API_KEY: secret,
  OCR_COST_PER_1000_PAGES_USD: priceUsd,

  EXTRACTION_PROVIDER: z
    .enum(["openrouter", "contract-fake"])
    .default("openrouter"),
  OPENROUTER_EXTRACTION_MODEL: text(DEFAULT_OPENROUTER_MODEL),
  RERANK_PROVIDER: z
    .enum(["openrouter", "contract-fake"])
    .default("openrouter"),
  OPENROUTER_RERANK_MODEL: text(DEFAULT_OPENROUTER_MODEL),
  OPENROUTER_API_KEY: secret,
  OPENROUTER_COST_PER_1M_INPUT_TOKENS_USD: priceUsd,
  OPENROUTER_COST_PER_1M_OUTPUT_TOKENS_USD: priceUsd,

  MATCH_WINNER_STRENGTH: ratio(DEFAULT_WINNER_STRENGTH),
  MATCH_WINNER_GAP: ratio(DEFAULT_WINNER_GAP),

  REVIEW_WINDOW_SECONDS_CURATED: seconds(DEFAULT_WINDOW_SECONDS_CURATED),
  REVIEW_WINDOW_SECONDS_CUSTOM: seconds(DEFAULT_WINDOW_SECONDS_CUSTOM),

  ANALYTICS_PROVIDER: z
    .enum(["posthog", "contract-fake", "none"])
    .default("none"),
  POSTHOG_HOST: text(DEFAULT_POSTHOG_HOST),
  POSTHOG_API_KEY: secret,

  RATE_LIMIT_SALT: secret,
})

type Variables = z.infer<typeof VARIABLES_SCHEMA>

/** A live PostHog target. It cannot be built without a project key. */
export type PosthogTarget = {
  provider: "posthog"
  /** Already stripped of trailing slashes, so a caller can append a path. */
  host: string
  apiKey: string
}

/** Why measurement is off, so the disabled case can still explain itself. */
export type AnalyticsDisabledReason =
  "disabled" | "unconfigured" | "outside_production"

/** Which analytics implementation this deployment resolves to, and with what. */
export type AnalyticsTarget =
  | PosthogTarget
  | { provider: "contract-fake" }
  | { provider: "none"; reason: AnalyticsDisabledReason }

/**
 * Measurement resolves here rather than in the provider seam, so the seam is a
 * switch over a settled decision and "PostHog without a key" is a shape that
 * does not exist.
 *
 * An unconfigured project key is the ordinary state of a local checkout and of
 * a fork: it disables measurement rather than failing a request. A configured
 * key outside production is disabled too — otherwise a developer reloading a
 * page sends real traffic into the deployed project, where it is
 * indistinguishable from public usage.
 */
function analyticsTarget(variables: Variables): AnalyticsTarget {
  if (variables.ANALYTICS_PROVIDER === "none") {
    return { provider: "none", reason: "disabled" }
  }

  if (variables.ANALYTICS_PROVIDER === "contract-fake") {
    return { provider: "contract-fake" }
  }

  if (variables.POSTHOG_API_KEY === null) {
    return { provider: "none", reason: "unconfigured" }
  }

  if (variables.APP_ENV !== "production") {
    return { provider: "none", reason: "outside_production" }
  }

  return {
    provider: "posthog",
    host: variables.POSTHOG_HOST.replace(/\/+$/, ""),
    apiKey: variables.POSTHOG_API_KEY,
  }
}

/**
 * The deterministic fakes exist for tests and fixture evaluation. Production is
 * the one environment where selecting one would be a silent lie about what ran,
 * so the configuration itself is refused rather than each seam checking again.
 */
export const APP_CONFIG_SCHEMA = VARIABLES_SCHEMA.superRefine(
  (variables, ctx) => {
    if (variables.APP_ENV !== "production") return

    const fakes = [
      {
        variable: "OCR_PROVIDER",
        configured: variables.OCR_PROVIDER,
        label: "OCR",
      },
      {
        variable: "EXTRACTION_PROVIDER",
        configured: variables.EXTRACTION_PROVIDER,
        label: "extraction",
      },
      {
        variable: "RERANK_PROVIDER",
        configured: variables.RERANK_PROVIDER,
        label: "rerank",
      },
      {
        variable: "ANALYTICS_PROVIDER",
        configured: variables.ANALYTICS_PROVIDER,
        label: "analytics",
      },
    ]

    for (const fake of fakes) {
      if (fake.configured !== "contract-fake") continue

      ctx.addIssue({
        code: "custom",
        path: [fake.variable],
        message: `The contract fake ${fake.label} provider is not allowed in production`,
      })
    }
  }
).transform((variables) => ({
  appEnv: variables.APP_ENV,

  ocrProvider: variables.OCR_PROVIDER,
  mistralOcrModel: variables.MISTRAL_OCR_MODEL,
  mistralApiKey: variables.MISTRAL_API_KEY,
  ocrCostPer1000PagesUsd: variables.OCR_COST_PER_1000_PAGES_USD,

  extractionProvider: variables.EXTRACTION_PROVIDER,
  extractionModel: variables.OPENROUTER_EXTRACTION_MODEL,
  rerankProvider: variables.RERANK_PROVIDER,
  rerankModel: variables.OPENROUTER_RERANK_MODEL,
  openRouterApiKey: variables.OPENROUTER_API_KEY,
  openRouterCostPer1MInputTokensUsd:
    variables.OPENROUTER_COST_PER_1M_INPUT_TOKENS_USD,
  openRouterCostPer1MOutputTokensUsd:
    variables.OPENROUTER_COST_PER_1M_OUTPUT_TOKENS_USD,

  matchWinnerStrength: variables.MATCH_WINNER_STRENGTH,
  matchWinnerGap: variables.MATCH_WINNER_GAP,

  reviewWindowSecondsCurated: variables.REVIEW_WINDOW_SECONDS_CURATED,
  reviewWindowSecondsCustom: variables.REVIEW_WINDOW_SECONDS_CUSTOM,

  analytics: analyticsTarget(variables),

  rateLimitSalt: variables.RATE_LIMIT_SALT,
}))

/** Everything configured about this deployment, parsed exactly once. */
export type AppConfig = z.infer<typeof APP_CONFIG_SCHEMA>

/**
 * A configuration this deployment cannot run with. `issues` names the variables
 * and what is wrong with them, never their values, so the failure is safe to
 * log where every other structured line goes.
 */
export class ConfigError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`This deployment is misconfigured: ${issues.join("; ")}`)
    this.name = "ConfigError"
    this.issues = issues
  }
}

/**
 * Parsed once per `Env` object, so callers may read configuration wherever they
 * need it. A deployed isolate holds one `Env` for its lifetime and parses once;
 * a test that builds `{ ...env, OVERRIDE }` gets its own parse, because the
 * override is a different object.
 */
const parsed = new WeakMap<Env, AppConfig>()

export function readConfig(env: Env): AppConfig {
  const memoized = parsed.get(env)
  if (memoized) return memoized

  const result = APP_CONFIG_SCHEMA.safeParse(env)

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`
      )
    )
  }

  parsed.set(env, result.data)
  return result.data
}
