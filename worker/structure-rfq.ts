/**
 * The "Structure RFQ" workflow step.
 *
 * The text read from the request's own documents goes to the configured
 * extraction model with the RFQ schema attached. What comes back is text, and
 * it is treated as text until it has survived one repair attempt, the schema,
 * and the business rules in `rfq-extraction.ts`. Only then is anything written
 * to `run_rfq` and `run_rfq_line_items`.
 *
 * Output that cannot be parsed or does not match the schema ends the run with a
 * short, sanitized explanation, because there is nothing honest to continue
 * with. Individual lines that fail a business rule do not: they are stored with
 * an explicit review state and without the fact that failed, so a later step
 * can neither price them nor mistake them for confirmed.
 *
 * As in `read-documents.ts`, nothing is thrown out of this module. A throw
 * would let the durable workflow retry a paid call and then abandon the step
 * while it still reads `active`.
 */

import {
  estimateExtractionCostUsd,
  ExtractionProviderError,
  selectExtractionProvider,
  type ExtractionDocument,
  type ExtractionResult,
} from "./providers/extraction"
import {
  applyBusinessRules,
  parseModelOutput,
  RFQ_EXTRACTION_INSTRUCTION,
  RFQ_SCHEMA_DESCRIPTION,
  RFQ_SCHEMA_NAME,
  rfqExtractionSchema,
  scoreExtraction,
  validateAgainstSchema,
  type ValidatedRfq,
} from "./rfq-extraction"
import { createRunStepRecorder, type RunStepRecorder } from "./run-steps"

export const STRUCTURE_RFQ_STEP_KEY = "structure-rfq"

/** The one kind of evidence this step attaches. */
const STRUCTURE_EVIDENCE_KIND = "structure"

/** Model text is stored for inspection, but never unbounded. */
const MAX_STORED_OUTPUT_CHARS = 12_000

export type StructureRfqOutcome =
  | {
      state: "complete"
      lineItemCount: number
      reviewCount: number
      elapsedMs: number
    }
  | { state: "error"; message: string }

export async function structureRfq(
  env: Env,
  runId: string
): Promise<StructureRfqOutcome> {
  const recorder = createRunStepRecorder(env, runId, STRUCTURE_RFQ_STEP_KEY)

  try {
    return await structure(env, runId, recorder)
  } catch (error) {
    const message = "The request could not be structured."

    console.error(
      JSON.stringify({
        event: "structure_rfq_failed",
        runId,
        step: STRUCTURE_RFQ_STEP_KEY,
        reason: "unexpected",
        error: error instanceof Error ? error.name : "unknown",
      })
    )

    try {
      await recorder.fail(message)
    } catch {
      // The database itself is unreachable, so there is nowhere left to record
      // the failure. Returning still stops the workflow rather than retrying.
    }

    return { state: "error", message }
  }
}

async function structure(
  env: Env,
  runId: string,
  recorder: RunStepRecorder
): Promise<StructureRfqOutcome> {
  const documents = await loadDocuments(env, runId)

  if (documents.length === 0) {
    const message = "No document text was available to structure."
    await recorder.fail(message)
    return { state: "error", message }
  }

  const startedAt = Date.now()
  await recorder.begin("Extracting customer, source, deadline, and line items…")

  const provider = selectExtractionProvider(env)
  let result: ExtractionResult

  try {
    result = await provider.extract({
      runId,
      instruction: RFQ_EXTRACTION_INSTRUCTION,
      documents,
      schema: rfqExtractionSchema,
      schemaName: RFQ_SCHEMA_NAME,
      schemaDescription: RFQ_SCHEMA_DESCRIPTION,
    })
  } catch (error) {
    const message =
      error instanceof ExtractionProviderError
        ? error.message
        : "The request could not be structured."

    console.error(
      JSON.stringify({
        event: "structure_rfq_failed",
        runId,
        step: STRUCTURE_RFQ_STEP_KEY,
        provider: provider.name,
        reason: "provider",
        status: error instanceof ExtractionProviderError ? error.status : null,
      })
    )

    await recorder.attachEvidence(STRUCTURE_EVIDENCE_KIND, {
      provider: provider.name,
      model: provider.model,
      state: "error",
      message,
      repaired: false,
      confidence: null,
      validated: null,
      originalOutput: null,
      issues: [],
      usage: null,
      metrics: { latencyMs: 0, elapsedMs: Date.now() - startedAt },
      // No usage was reported, so no estimate is honest here.
      estimatedCostUsd: null,
      reportedCostUsd: null,
    })

    await recorder.fail(message)
    return { state: "error", message }
  }

  const shared = {
    provider: provider.name,
    model: result.model,
    usage: result.usage,
    originalOutput: result.text.slice(0, MAX_STORED_OUTPUT_CHARS),
    estimatedCostUsd: estimateExtractionCostUsd(env, result.usage),
    reportedCostUsd: result.reportedCostUsd,
  }

  const parsed = parseModelOutput(result.text)

  if (parsed.state === "irreparable") {
    return await stopWithValidationFailure(runId, recorder, {
      ...shared,
      message: `${parsed.reason} One repair attempt was made.`,
      issues: [],
      repaired: false,
      latencyMs: result.latencyMs,
      elapsedMs: Date.now() - startedAt,
    })
  }

  const checked = validateAgainstSchema(parsed.value)

  if (checked.state === "invalid") {
    return await stopWithValidationFailure(runId, recorder, {
      ...shared,
      message: "The model output did not match the required RFQ schema.",
      issues: checked.issues,
      repaired: parsed.repaired,
      latencyMs: result.latencyMs,
      elapsedMs: Date.now() - startedAt,
    })
  }

  const knownSkus = await loadKnownSkus(env, checked.rfq.lineItems)
  const validated = applyBusinessRules(checked.rfq, knownSkus)
  const confidence = scoreExtraction(validated, parsed.repaired)
  const elapsedMs = Date.now() - startedAt

  await persistRfq(env, runId, validated)
  await recorder.attachEvidence(STRUCTURE_EVIDENCE_KIND, {
    provider: provider.name,
    model: result.model,
    state: "complete",
    message: null,
    repaired: parsed.repaired,
    confidence,
    validated,
    originalOutput: shared.originalOutput,
    issues: [],
    usage: result.usage,
    metrics: { latencyMs: result.latencyMs, elapsedMs },
    estimatedCostUsd: shared.estimatedCostUsd,
    reportedCostUsd: shared.reportedCostUsd,
  })

  const reviewCount = validated.lineItems.filter(
    (line) => line.state === "review_required"
  ).length

  const total = validated.lineItems.length

  await recorder.complete(
    total === 0
      ? `No line items could be read from the request. Confidence ${confidence.label}.`
      : `Validated ${total} ${total === 1 ? "line" : "lines"}` +
          (reviewCount > 0
            ? `, ${reviewCount} needing review. `
            : " with no business-rule failures. ") +
          `Confidence ${confidence.label} (${confidence.score.toFixed(2)}).`
  )

  console.log(
    JSON.stringify({
      event: "structure_rfq_completed",
      runId,
      step: STRUCTURE_RFQ_STEP_KEY,
      provider: provider.name,
      lineItems: validated.lineItems.length,
      reviewLines: reviewCount,
      repaired: parsed.repaired,
      confidence: confidence.label,
      elapsedMs,
    })
  )

  return {
    state: "complete",
    lineItemCount: validated.lineItems.length,
    reviewCount,
    elapsedMs,
  }
}

/**
 * Irreparable output and a failed schema are the same kind of event: nothing
 * canonical was produced, so the run stops here with what is known.
 */
async function stopWithValidationFailure(
  runId: string,
  recorder: RunStepRecorder,
  detail: {
    provider: string
    model: string
    message: string
    issues: string[]
    repaired: boolean
    usage: ExtractionResult["usage"]
    originalOutput: string
    estimatedCostUsd: number | null
    reportedCostUsd: number | null
    latencyMs: number
    elapsedMs: number
  }
): Promise<StructureRfqOutcome> {
  console.error(
    JSON.stringify({
      event: "structure_rfq_failed",
      runId,
      step: STRUCTURE_RFQ_STEP_KEY,
      provider: detail.provider,
      reason: detail.issues.length > 0 ? "schema" : "irreparable",
      issues: detail.issues.length,
    })
  )

  await recorder.attachEvidence(STRUCTURE_EVIDENCE_KIND, {
    provider: detail.provider,
    model: detail.model,
    state: "error",
    message: detail.message,
    repaired: detail.repaired,
    confidence: null,
    validated: null,
    originalOutput: detail.originalOutput,
    issues: detail.issues,
    usage: detail.usage,
    metrics: { latencyMs: detail.latencyMs, elapsedMs: detail.elapsedMs },
    estimatedCostUsd: detail.estimatedCostUsd,
    reportedCostUsd: detail.reportedCostUsd,
  })

  await recorder.fail(detail.message)

  return { state: "error", message: detail.message }
}

/* -------------------------------------------------------------------------- */
/* Review outcome                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One line-level correction the owner made during review, resolved to values.
 *
 * `quantity` carries the amount the owner settled on; `field` confirms the line
 * exactly as extracted. Both are addressed by position within the run, because
 * that is the identity a line item has once it is persisted.
 */
export type ReviewLineDecision =
  | { position: number; kind: "quantity"; quantity: number }
  | { position: number; kind: "field" }

/**
 * Applies one reviewed line decision to this step's own table.
 *
 * The caller has already arbitrated the review; nothing here re-checks that a
 * decision was approved, so the statements are plain updates against resolved
 * values. Re-running one is harmless: the same values are written again and the
 * row lands in the same state, which is what lets the workflow retry the apply
 * step without bookkeeping.
 *
 * Unlike the step above, this *does* throw when the addressed line is missing.
 * It is called from a durable workflow step rather than a paid provider call,
 * and a silent no-op would let the run record an outcome as applied while a
 * correction the owner made was quietly dropped.
 */
export async function applyReviewLineDecision(
  env: Env,
  runId: string,
  decision: ReviewLineDecision
): Promise<void> {
  const statement =
    decision.kind === "quantity"
      ? env.DB.prepare(
          `UPDATE run_rfq_line_items
              SET quantity = ?,
                  validation_state = 'accepted',
                  validation_reason = 'Quantity confirmed by the owner during review.'
            WHERE run_id = ? AND position = ?
        RETURNING position`
        ).bind(decision.quantity, runId, decision.position)
      : env.DB.prepare(
          `UPDATE run_rfq_line_items
              SET validation_state = 'accepted',
                  validation_reason = 'Confirmed by the owner during review, exactly as extracted.'
            WHERE run_id = ? AND position = ?
        RETURNING position`
        ).bind(runId, decision.position)

  const updated = await statement.first<{ position: number }>()

  if (!updated) {
    throw new Error(
      `No line item at position ${decision.position} for run ${runId}.`
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

async function loadDocuments(
  env: Env,
  runId: string
): Promise<ExtractionDocument[]> {
  const rows = await env.DB.prepare(
    `SELECT s.label, s.kind, p.page_number, p.markdown
       FROM run_source_pages p
       JOIN run_sources s ON s.id = p.source_id
      WHERE p.run_id = ?
      ORDER BY s.position ASC, p.page_number ASC`
  )
    .bind(runId)
    .all<{
      label: string
      kind: string
      page_number: number
      markdown: string
    }>()

  return rows.results.map((row) => ({
    label: row.label,
    kind: row.kind,
    pageNumber: row.page_number,
    markdown: row.markdown,
  }))
}

/** Only the SKUs the model actually claimed are looked up. */
async function loadKnownSkus(
  env: Env,
  lines: { catalogSku: string | null }[]
): Promise<Set<string>> {
  const claimed = [
    ...new Set(
      lines
        .map((line) => line.catalogSku?.trim().toUpperCase())
        .filter((sku): sku is string => Boolean(sku))
    ),
  ]

  if (claimed.length === 0) return new Set()

  const placeholders = claimed.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT sku FROM catalog_products WHERE sku IN (${placeholders})`
  )
    .bind(...claimed)
    .all<{ sku: string }>()

  return new Set(rows.results.map((row) => row.sku))
}

async function persistRfq(
  env: Env,
  runId: string,
  validated: ValidatedRfq
): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM run_rfq_line_items WHERE run_id = ?`).bind(
      runId
    ),
    env.DB.prepare(
      `INSERT INTO run_rfq (
         run_id, company_name, contact_name, contact_email, contact_phone,
         delivery_location, source_channel, source_subject, source_received_at,
         source_references, deadline_date, deadline_text, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         company_name = excluded.company_name,
         contact_name = excluded.contact_name,
         contact_email = excluded.contact_email,
         contact_phone = excluded.contact_phone,
         delivery_location = excluded.delivery_location,
         source_channel = excluded.source_channel,
         source_subject = excluded.source_subject,
         source_received_at = excluded.source_received_at,
         source_references = excluded.source_references,
         deadline_date = excluded.deadline_date,
         deadline_text = excluded.deadline_text`
    ).bind(
      runId,
      validated.customer.companyName,
      validated.customer.contactName,
      validated.customer.contactEmail,
      validated.customer.contactPhone,
      validated.customer.deliveryLocation,
      validated.source.channel,
      validated.source.subject,
      validated.source.receivedAt,
      JSON.stringify(validated.source.references),
      validated.deadline.date,
      validated.deadline.text,
      now
    ),
    ...validated.lineItems.map((line) =>
      env.DB.prepare(
        `INSERT INTO run_rfq_line_items (
           id, run_id, position, reference, description, quantity, unit,
           catalog_sku, source_label, source_page, validation_state,
           validation_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        runId,
        line.position,
        line.reference,
        line.description,
        line.quantity,
        line.unit,
        line.catalogSku,
        line.sourceLabel,
        line.sourcePage,
        line.state,
        line.reason,
        now
      )
    ),
  ])
}
