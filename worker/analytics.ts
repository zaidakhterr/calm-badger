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

import { ADAPTER_IDS } from "./adapters"
import {
  selectAnalyticsProvider,
  type AnalyticsEvent,
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
 * The complete property vocabulary, and the only values each key may take.
 * Every one of these is a small closed set: no free text, no identifier, no
 * number that came out of a document.
 */
const PROPERTY_BUCKETS: Record<string, readonly string[]> = {
  source_kind: ["curated", "custom"],
  scenario_id: [...SCENARIO_IDS, "none"],
  adapter: [...ADAPTER_IDS],
  decision: ["approve", "reject"],
  reason: [
    "unknown_scenario",
    "upload_too_large",
    "unreadable_form",
    "invalid_submission",
  ],
  review_required: ["true", "false"],
  $pathname: ["/", "/runs/[view]", "/[other]"],
}

export type FunnelProperties = Record<string, string | boolean | undefined>

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
  const clean: Record<string, AnalyticsValue> = {}

  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue

    const allowed = PROPERTY_BUCKETS[key]
    if (!allowed) continue

    const candidate = typeof value === "boolean" ? String(value) : value
    if (!allowed.includes(candidate)) continue

    clean[key] = candidate
  }

  return clean
}

function send(env: Env, ctx: ExecutionContext, event: AnalyticsEvent): void {
  try {
    const provider = selectAnalyticsProvider(env)

    ctx.waitUntil(
      provider.capture(event).catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: "analytics_capture_failed",
            analyticsEvent: event.event,
            provider: provider.name,
            error: error instanceof Error ? error.name : "unknown",
          })
        )
      })
    )
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
