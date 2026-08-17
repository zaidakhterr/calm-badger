/**
 * What this demo is allowed to measure.
 *
 * Two questions are worth answering: did anyone visit, and did the workflow
 * reach its end. Everything else about a run — the request, the customer, the
 * filenames, the matched products, the prices, the prompts, the model output,
 * the errors — is business content and never leaves the Worker.
 *
 * That rule is enforced here rather than trusted at each call site. An event
 * name has to be one of the funnel names below, every property has to be a
 * declared key, and every value has to be one of that key's declared buckets. A
 * name or value that is not on the list is dropped, so a future caller cannot
 * widen the payload by passing a richer object: the worst it can do is send
 * less.
 *
 * Automatic pageviews carry a bucketed path — `/` or `/runs/[view]` — with the
 * view identifier and the whole query string removed before the event is built,
 * not filtered out afterwards. Because capture is server side, there is no
 * browser SDK, no cookie, and no client identity; a client-side route change
 * inside the single-page application is therefore not counted, which is the
 * honest cost of not shipping a tracker.
 */

import { z } from "zod"

import { ADAPTER_IDS } from "./adapters"
import { readConfig } from "./env"
import {
  selectAnalyticsProvider,
  type AnalyticsEvent,
  type AnalyticsProvider,
  type AnalyticsValue,
} from "./providers/analytics"
import { visitorHash } from "./rate-limit"
import { SCENARIO_IDS } from "./scenarios"

const HOUR_MS = 60 * 60 * 1000

/** The complete set of product events. Nothing else may be captured. */
export const FUNNEL_EVENTS = [
  "rfq_run_started",
  "rfq_run_rejected",
  "rfq_run_rate_limited",
  "rfq_review_decided",
  "rfq_quote_delivered",
] as const

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number]

const PAGEVIEW_EVENT = "$pageview"

/**
 * Why a submission was refused. Only the four codes that name something the
 * visitor submitted are reported; a transport-level refusal is still counted as
 * a rejection, but goes out without a reason, exactly as it always has.
 */
const REASON_BUCKET = z
  .enum([
    "unknown_scenario",
    "upload_too_large",
    "unreadable_form",
    "invalid_submission",
  ])
  .or(z.string().transform(() => undefined))

/** A flag, sent as the word: the buckets are strings, so a boolean becomes one. */
const FLAG_BUCKET = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((flag): "true" | "false" =>
    flag === true || flag === "true" ? "true" : "false"
  )

/**
 * The complete property vocabulary, and the only values each key may take.
 * Every one of these is a small closed set: no free text, no identifier, no
 * number that came out of a document.
 *
 * It is a schema rather than a list of allowed words because it is the thing
 * that decides what leaves: a key that is not declared here is stripped, and a
 * declared key holding an undeclared value is caught back to nothing. A future
 * caller passing a richer object therefore sends less, never more.
 */
const FUNNEL_PROPERTIES_SCHEMA = z
  .object({
    source_kind: z.enum(["curated", "custom"]).optional().catch(undefined),
    scenario_id: z
      .enum([...SCENARIO_IDS, "none"])
      .optional()
      .catch(undefined),
    adapter: z.enum(ADAPTER_IDS).optional().catch(undefined),
    decision: z.enum(["approve", "reject"]).optional().catch(undefined),
    reason: REASON_BUCKET.optional().catch(undefined),
    review_required: FLAG_BUCKET.optional().catch(undefined),
    $pathname: z
      .enum(["/", "/runs/[view]", "/[other]"])
      .optional()
      .catch(undefined),
  })
  // A key that was caught to nothing is not a measurement; it leaves as an
  // absent property rather than as an explicit null on the wire.
  .transform((properties) => {
    const declared: Record<string, AnalyticsValue> = {}

    for (const [key, value] of Object.entries(properties)) {
      if (value !== undefined) declared[key] = value
    }

    return declared
  })

/** What a caller may hand `captureFunnelEvent`, before any of it is checked. */
export type FunnelProperties = z.input<typeof FUNNEL_PROPERTIES_SCHEMA>

/**
 * Records one funnel event. Failures are swallowed on purpose: a measurement
 * gap is not a reason to fail a reviewer's run.
 */
export function captureFunnelEvent(
  env: Env,
  ctx: ExecutionContext,
  input: {
    event: FunnelEvent
    /** A run id, or a rotating visitor hash for events with no run yet. */
    distinctId: string
    properties?: FunnelProperties
  }
): void {
  if (!FUNNEL_EVENTS.includes(input.event)) return

  send(env, ctx, {
    event: input.event,
    distinctId: input.distinctId,
    properties: sanitizeProperties(input.properties ?? {}),
    timestamp: new Date().toISOString(),
  })
}

/**
 * Records an automatic pageview for a document request. Only successful HTML
 * GETs count; API traffic, assets, and redirects are not pageviews.
 */
export async function capturePageview(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  response: Response,
  now: Date = new Date()
): Promise<void> {
  if (request.method !== "GET" || response.status !== 200) return
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
    return
  }

  const url = new URL(request.url)
  if (url.pathname.startsWith("/api/")) return

  const pathname = bucketPath(url.pathname)
  const windowStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)

  send(env, ctx, {
    event: PAGEVIEW_EVENT,
    // Rotates every hour and is derived from a secret, so two visits an hour
    // apart cannot be joined and no visitor identifier persists anywhere.
    distinctId: await visitorHash(env, request, "analytics", windowStart),
    properties: {
      $pathname: pathname,
      // Deliberately rebuilt from the origin and the bucketed path: the real
      // URL carries the view identifier and any query string, and neither is
      // ever sent.
      $current_url: `${url.origin}${pathname}`,
    },
    timestamp: now.toISOString(),
  })
}

/**
 * The path as a bucket. A run URL is a bearer link, so its identifier is
 * removed here exactly as it is removed from request logs.
 */
export function bucketPath(pathname: string): string {
  if (pathname === "/") return "/"
  if (/^\/runs\/[^/]+\/?$/.test(pathname)) return "/runs/[view]"
  return "/[other]"
}

/**
 * The route an API request took, for structured logs. Identifiers are replaced
 * by their parameter names so a log line says which endpoint was called without
 * carrying the capability-adjacent view identifier or any query string.
 */
export function logRoute(pathname: string): string {
  if (!pathname.startsWith("/api/")) return bucketPath(pathname)

  return pathname
    .replace(/^\/api\/runs\/[^/]+/, "/api/runs/:viewId")
    .replace(/\/sources\/[^/]+$/, "/sources/:sourceId")
}

/** Drops every key and value that is not declared above. */
function sanitizeProperties(
  properties: FunnelProperties
): Record<string, AnalyticsValue> {
  const parsed = FUNNEL_PROPERTIES_SCHEMA.safeParse(properties)

  return parsed.success ? parsed.data : {}
}

/** Capture never fails a request: a measurement gap is a log line. */
async function captureQuietly(
  provider: AnalyticsProvider,
  event: AnalyticsEvent
): Promise<void> {
  try {
    await provider.capture(event)
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "analytics_capture_failed",
        analyticsEvent: event.event,
        provider: provider.name,
        error: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}

function send(env: Env, ctx: ExecutionContext, event: AnalyticsEvent): void {
  try {
    const provider = selectAnalyticsProvider(readConfig(env))

    ctx.waitUntil(captureQuietly(provider, event))
  } catch (error) {
    // Selecting a provider can fail on a misconfiguration. Measurement stops;
    // the request it was measuring does not.
    console.warn(
      JSON.stringify({
        event: "analytics_unavailable",
        analyticsEvent: event.event,
        error: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}
