/**
 * The analytics seam.
 *
 * Like OCR, extraction, and reranking, product measurement is an interface with
 * a live implementation (`posthog-analytics.ts`, EU ingestion) and a
 * deterministic contract fake (`contract-fake-analytics.ts`) that tests read
 * back. A third implementation does nothing at all, and is what runs when no
 * project key is configured, and when one is configured outside production — a
 * demo without analytics is a demo that still works, and a developer's own
 * traffic is not public usage.
 *
 * Nothing here decides *what* may be sent. That is `worker/analytics.ts`, which
 * is the only caller: it builds an event out of an allowlist and hands the
 * finished, already-sanitized envelope to whichever provider is selected.
 */

import type { AppConfig } from "../env"

import { createContractFakeAnalyticsProvider } from "./contract-fake-analytics"
import { createPosthogAnalyticsProvider } from "./posthog-analytics"

/** A property value narrow enough that it cannot smuggle a document in. */
export type AnalyticsValue = string | number | boolean

export type AnalyticsEvent = {
  event: string
  /**
   * A run identifier or a rotating visitor hash. Never a person, an address, a
   * cookie, or anything that outlives its window.
   */
  distinctId: string
  properties: Record<string, AnalyticsValue>
  timestamp: string
}

export interface AnalyticsProvider {
  readonly name: string
  capture(event: AnalyticsEvent): Promise<void>
}

const noopProvider: AnalyticsProvider = {
  name: "none",
  async capture() {
    // Measurement is optional; the workflow is not.
  },
}

/** Said once per isolate: a disabled provider should not narrate every event. */
let disabledOutsideProductionLogged = false

/**
 * Which implementation this deployment measures with. Whether a key is present
 * and whether this isolate may use it are settled by the configuration schema,
 * which is why a live target arrives here already carrying its key: "PostHog
 * without a project key" is not a shape this function can be handed.
 */
export function selectAnalyticsProvider(config: AppConfig): AnalyticsProvider {
  const target = config.analytics

  if (target.provider === "contract-fake") {
    return createContractFakeAnalyticsProvider()
  }

  if (target.provider === "posthog") {
    return createPosthogAnalyticsProvider(target)
  }

  // A key is configured but this isolate may not use it: a local checkout or a
  // preview would otherwise send real traffic — and real pageviews from a
  // developer reloading a page — into the deployed project, where it is
  // indistinguishable from public usage. Said once per isolate, because a
  // disabled provider should not narrate every event.
  if (
    target.reason === "outside_production" &&
    !disabledOutsideProductionLogged
  ) {
    disabledOutsideProductionLogged = true
    console.log(
      JSON.stringify({
        event: "analytics_disabled_outside_production",
        appEnv: config.appEnv,
        detail: "a project key is configured but only production may send",
      })
    )
  }

  return noopProvider
}
