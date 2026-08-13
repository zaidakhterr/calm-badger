/**
 * The analytics seam.
 *
 * Like OCR, extraction, and reranking, product measurement is an interface with
 * a live implementation (`posthog-analytics.ts`, EU ingestion) and a
 * deterministic contract fake (`contract-fake-analytics.ts`) that tests read
 * back. A third implementation does nothing at all, and is what runs when no
 * project key is configured — a demo without analytics is a demo that still
 * works.
 *
 * Nothing here decides *what* may be sent. That is `worker/analytics.ts`, which
 * is the only caller: it builds an event out of an allowlist and hands the
 * finished, already-sanitized envelope to whichever provider is selected.
 */

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

export function selectAnalyticsProvider(env: Env): AnalyticsProvider {
  const configured: string = env.ANALYTICS_PROVIDER

  if (configured === "none") return noopProvider

  if (configured === "contract-fake") {
    if (env.APP_ENV === "production") {
      throw new Error(
        "The contract fake analytics provider is not allowed in production"
      )
    }

    return createContractFakeAnalyticsProvider()
  }

  // An unconfigured project key is the ordinary state of a local checkout and
  // of a fork. It disables measurement rather than failing a request.
  if (!env.POSTHOG_API_KEY?.trim()) return noopProvider

  return createPosthogAnalyticsProvider(env)
}
