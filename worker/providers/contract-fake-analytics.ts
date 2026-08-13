/**
 * The deterministic analytics provider used by tests and local runs.
 *
 * It reaches no network. Captured envelopes are kept in module state so a test
 * can assert exactly what the application would have sent — which is how the
 * "no RFQ, customer, filename, product, price, prompt, response, or raw error
 * data" rule is checked as behaviour rather than as a comment.
 */

import type { AnalyticsEvent, AnalyticsProvider } from "./analytics"

const captured: AnalyticsEvent[] = []

export function createContractFakeAnalyticsProvider(): AnalyticsProvider {
  return {
    name: "contract-fake",
    capture(event: AnalyticsEvent): Promise<void> {
      captured.push(event)
      return Promise.resolve()
    },
  }
}

/** Everything captured so far, oldest first. */
export function capturedAnalyticsEvents(): AnalyticsEvent[] {
  return [...captured]
}

export function resetCapturedAnalyticsEvents(): void {
  captured.length = 0
}
