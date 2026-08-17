/**
 * The "Build estimate" workflow step.
 *
 * It prices a run that needs no human judgement: every requested line has an
 * accepted product match and a confirmed quantity, and the customer is
 * resolved. Anything else is left alone — the node stays `waiting` with an
 * honest summary, and the owner review node of the next ticket decides what
 * happens to it. Unreviewed lines are never priced.
 *
 * No provider is called here and no model is asked for an amount: the whole
 * step is a deterministic read of catalogue and customer rules, so the same run
 * always produces the same quote. The body is still wrapped exactly like the
 * provider steps, because a database failure must end as a terminal error
 * rather than leave the node reading `active` forever.
 */

import { formatAmount, ROUNDING_NOTE, VAT_RATE_BP } from "./pricing"
import { assembleQuote, type CanonicalQuote } from "./quote"
import { createRunStepRecorder, type RunStepRecorder } from "./run-steps"

export const BUILD_ESTIMATE_STEP_KEY = "build-estimate"

const ESTIMATE_EVIDENCE_KIND = "estimate"

export type BuildEstimateOutcome =
  | {
      state: "complete"
      quoteNumber: string
      lineCount: number
      totalCents: number
      elapsedMs: number
    }
  /** Priced nothing on purpose: the run needs a human first. */
  | { state: "blocked"; reason: string }
  | { state: "error"; message: string }

export type BuildEstimateOptions = {
  /**
   * Whether an owner review already ran. After one, "not priceable" is no
   * longer something a human can fix, so it is a terminal error rather than a
   * node that waits for a review that has already happened.
   */
  reviewed: boolean
}

export async function buildEstimate(
  env: Env,
  runId: string,
  options: BuildEstimateOptions = { reviewed: false }
): Promise<BuildEstimateOutcome> {
  const step = createRunStepRecorder(env, runId, BUILD_ESTIMATE_STEP_KEY)

  try {
    return await build(env, runId, options, step)
  } catch (error) {
    const message = "The estimate could not be built."

    console.error(
      JSON.stringify({
        event: "build_estimate_failed",
        runId,
        step: BUILD_ESTIMATE_STEP_KEY,
        reason: "unexpected",
        error: error instanceof Error ? error.name : "unknown",
      })
    )

    try {
      await step.fail(message)
    } catch {
      // Nowhere left to record the failure; returning still stops the workflow.
    }

    return { state: "error", message }
  }
}

async function build(
  env: Env,
  runId: string,
  options: BuildEstimateOptions,
  step: RunStepRecorder
): Promise<BuildEstimateOutcome> {
  const startedAt = Date.now()
  const assembly = await assembleQuote(env, runId)

  if (assembly.state === "blocked") {
    if (options.reviewed) {
      // The owner has already decided everything that was open. Waiting again
      // would be waiting for nobody, so this ends as a terminal state.
      const message = `The approved corrections still leave this run unpriceable. ${assembly.reason}`

      await step.fail(message)

      console.error(
        JSON.stringify({
          event: "build_estimate_blocked_after_review",
          runId,
          step: BUILD_ESTIMATE_STEP_KEY,
        })
      )

      return { state: "error", message }
    }

    // The run needs a human, so the node keeps its `waiting` state and simply
    // says why. The run itself stays active with no active step, which is the
    // same posture every earlier step uses when it stops short.
    await step.hold(
      `Waiting for owner review before pricing. ${assembly.reason}`
    )

    console.log(
      JSON.stringify({
        event: "build_estimate_held",
        runId,
        step: BUILD_ESTIMATE_STEP_KEY,
      })
    )

    return { state: "blocked", reason: assembly.reason }
  }

  const quote = assembly.quote
  const elapsedMs = Date.now() - startedAt

  await persistQuote(env, runId, quote)
  await step.attachEvidence(ESTIMATE_EVIDENCE_KIND, {
    state: "complete",
    message: null,
    quote,
    rules: describeRules(quote),
    totals: {
      lineCount: quote.totals.lineCount,
      subtotalCents: quote.totals.subtotalCents,
      vatRateBp: quote.totals.vatRateBp,
      vatCents: quote.totals.vatCents,
      totalCents: quote.totals.totalCents,
      elapsedMs,
    },
  })

  const lineCount = quote.totals.lineCount

  await step.complete(
    `Priced ${lineCount} ${lineCount === 1 ? "line" : "lines"} to €${formatAmount(quote.totals.totalCents)} including VAT.`
  )
  // Delivery is the next node to wake up; give it a sentence that says what it
  // is waiting for now that a quote exists.
  await step.setWaitingSummary(
    "deliver",
    "Ready to send through the simulated Generic ERP Webhook."
  )

  console.log(
    JSON.stringify({
      event: "build_estimate_completed",
      runId,
      step: BUILD_ESTIMATE_STEP_KEY,
      lines: quote.totals.lineCount,
      elapsedMs,
    })
  )

  return {
    state: "complete",
    quoteNumber: quote.quoteNumber,
    lineCount: quote.totals.lineCount,
    totalCents: quote.totals.totalCents,
    elapsedMs,
  }
}

/** How often each rule decided a line, for the evidence panel. */
function describeRules(quote: CanonicalQuote) {
  const counts = new Map<string, number>()

  for (const line of quote.lines) {
    counts.set(line.pricing.rule, (counts.get(line.pricing.rule) ?? 0) + 1)
  }

  return {
    precedence: quote.metadata.pricingPrecedence,
    applied: [...counts.entries()].map(([rule, lineCount]) => ({
      rule,
      lineCount,
    })),
    vatRateBp: VAT_RATE_BP,
    rounding: ROUNDING_NOTE,
    note: "Precedence is an ordered fallback: the first applicable rule prices the line, and no language model is asked for an amount.",
  }
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

export async function loadQuote(
  env: Env,
  runId: string
): Promise<CanonicalQuote | null> {
  const row = await env.DB.prepare(
    `SELECT document FROM run_quotes WHERE run_id = ?`
  )
    .bind(runId)
    .first<{ document: string }>()

  if (!row) return null

  try {
    return JSON.parse(row.document) as CanonicalQuote
  } catch {
    return null
  }
}

async function persistQuote(
  env: Env,
  runId: string,
  quote: CanonicalQuote
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO run_quotes (
       run_id, quote_number, currency, line_count, subtotal_cents,
       vat_rate_bp, vat_cents, total_cents, document, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET
       quote_number = excluded.quote_number,
       currency = excluded.currency,
       line_count = excluded.line_count,
       subtotal_cents = excluded.subtotal_cents,
       vat_rate_bp = excluded.vat_rate_bp,
       vat_cents = excluded.vat_cents,
       total_cents = excluded.total_cents,
       document = excluded.document,
       created_at = excluded.created_at`
  )
    .bind(
      runId,
      quote.quoteNumber,
      quote.currency,
      quote.totals.lineCount,
      quote.totals.subtotalCents,
      quote.totals.vatRateBp,
      quote.totals.vatCents,
      quote.totals.totalCents,
      JSON.stringify(quote),
      new Date().toISOString()
    )
    .run()
}
