/**
 * PostHog, EU ingestion, server side only.
 *
 * Every event is captured from the Worker against `POSTHOG_HOST`
 * (`https://eu.i.posthog.com`). There is no browser SDK in this application, so
 * there is no cookie, no `distinct_id` stored on a device, no element
 * autocapture, no session replay, no heatmap, no exception capture, and no web
 * performance capture — those are all client-side features that were never
 * loaded rather than settings someone has to remember to switch off.
 *
 * `$process_person_profile: false` is sent on every event, so PostHog records
 * the event and never creates or updates a person profile for the identifier.
 * The identifier itself is either a run id or a hash that rotates hourly.
 */

import type { AnalyticsEvent, AnalyticsProvider } from "./analytics"

export function createPosthogAnalyticsProvider(env: Env): AnalyticsProvider {
  const host = env.POSTHOG_HOST.replace(/\/+$/, "")
  const apiKey = env.POSTHOG_API_KEY

  return {
    name: "posthog-eu",
    async capture(event: AnalyticsEvent): Promise<void> {
      const response = await fetch(`${host}/i/v0/e/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          event: event.event,
          distinct_id: event.distinctId,
          timestamp: event.timestamp,
          properties: {
            ...event.properties,
            // No person profile, and therefore no identity to merge, alias, or
            // enrich later.
            $process_person_profile: false,
          },
        }),
      })

      if (!response.ok) {
        // The body may echo the request; only the status is safe to keep, and
        // the caller treats a rejected event as a measurement gap, not an error.
        throw new Error(`PostHog rejected the event with ${response.status}`)
      }
    },
  }
}
