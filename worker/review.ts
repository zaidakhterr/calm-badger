/**
 * The "Review required" workflow node.
 *
 * Every kind of uncertainty this pipeline can produce — an unresolved customer,
 * a quantity that failed business validation, an extracted field that did not
 * survive it, a product match no heuristic would accept — consolidates here,
 * into one linear node that blocks pricing and delivery. The workflow does not
 * branch: it stops, hibernates on a `waitForEvent`, and continues down the same
 * deterministic path afterwards.
 *
 * Three rules hold this together.
 *
 * 1. The event carries no authority. The Worker validates the owner capability,
 *    the review window, and the persisted review state *before* an event is
 *    sent; the workflow then re-reads D1 rather than trusting the payload. A
 *    forged or replayed event finds an already-decided review and changes
 *    nothing.
 * 2. One transition out of `pending` wins. Approve, reject, and expire are all
 *    conditional updates guarded on `state = 'pending'`, and only the update
 *    that actually changed a row is allowed to send an event or write a
 *    terminal state. Repeated, premature, racing, and expired decisions
 *    therefore settle on one stable business outcome instead of progressing
 *    twice.
 * 3. Nothing is invented. The owner may accept a proposal, choose one of the
 *    top three alternatives, search the complete catalogue, correct a quantity,
 *    or select an existing customer. Every one of those resolves to a row that
 *    already exists in the catalogue; there is no path here that creates a
 *    product or a customer.
 *
 * Approved corrections become wording the owner's anonymous browser workspace
 * records for that one customer — see `workspace_product_aliases` in migration
 * 0009. The seeded catalogue is never written to, so learning cannot leak into
 * the global dataset or another visitor's run.
 */

import { normaliseText } from "./catalog/retrieval"
import { MATCH_PRODUCTS_STEP_KEY } from "./match-products"
import { MAX_LINE_QUANTITY } from "./rfq-extraction"

export const REVIEW_STEP_KEY = "review-required"
export const REVIEW_STEP_TITLE = "Review required"

/** The event type the Worker delivers to a hibernating workflow instance. */
export const REVIEW_EVENT_TYPE = "owner-review"

/**
 * How long an owner has. The window mirrors the run's own retention, because a
 * review must never outlive the data it decides: custom uploads and everything
 * derived from them are deleted after 24 hours, curated sample runs after seven
 * days. Both are configurable so the expiry path is testable in seconds.
 */
const DEFAULT_WINDOW_SECONDS = {
  curated: 7 * 24 * 60 * 60,
  custom: 24 * 60 * 60,
}

export type ReviewState =
  "not_required" | "pending" | "approved" | "rejected" | "expired"

export type ReviewOpening =
  | { state: "not_required" }
  | {
      state: "required"
      itemCount: number
      expiresAt: string
      timeoutMs: number
    }
  | { state: "error"; message: string }

type ReviewRow = {
  state: string
  item_count: number
  opened_at: string
  expires_at: string
  decided_at: string | null
  summary: string
}

type ItemRow = {
  id: string
  kind: string
  position: number
  source_phrase: string
  detail: string
  proposed_label: string
  proposed_sku: string | null
  proposed_quantity: number | null
  proposed_customer_id: string | null
  confidence_label: string
  confidence_score: number
  heuristic: string
  reasons: string
  alternatives: string
  state: string
  decision: string | null
  resolved_sku: string | null
  resolved_quantity: number | null
  resolved_customer_id: string | null
  resolved_at: string | null
}

/* -------------------------------------------------------------------------- */
/* Opening the node                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Collects everything the run cannot decide on its own. Returns `not_required`
 * when there is nothing to ask, in which case the workflow prices immediately
 * and no review node is ever shown.
 */
export async function openReview(
  env: Env,
  runId: string
): Promise<ReviewOpening> {
  try {
    return await open(env, runId)
  } catch (error) {
    const message = "The review node could not be opened."

    console.error(
      JSON.stringify({
        event: "open_review_failed",
        runId,
        step: REVIEW_STEP_KEY,
        error: error instanceof Error ? error.name : "unknown",
      })
    )

    try {
      await failStep(env, runId, message)
    } catch {
      // Nowhere left to record the failure; returning still stops the workflow.
    }

    return { state: "error", message }
  }
}

async function open(env: Env, runId: string): Promise<ReviewOpening> {
  const existing = await loadReviewRow(env, runId)

  // The durable step is replay-safe on its own, but a reopened review must
  // never restart a window the owner has already spent.
  if (existing) {
    return existing.state === "pending"
      ? {
          state: "required",
          itemCount: existing.item_count,
          expiresAt: existing.expires_at,
          timeoutMs: remainingMs(existing.expires_at),
        }
      : { state: "not_required" }
  }

  const items = await collectItems(env, runId)
  if (items.length === 0) return { state: "not_required" }

  const run = await env.DB.prepare(`SELECT source_kind FROM runs WHERE id = ?`)
    .bind(runId)
    .first<{ source_kind: string }>()

  const now = new Date()
  const windowMs = reviewWindowMs(env, run?.source_kind ?? "curated")
  const expiresAt = new Date(now.getTime() + windowMs).toISOString()
  const summary = describeItems(items)

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO run_reviews
         (run_id, state, item_count, opened_at, expires_at, decided_at, summary)
       VALUES (?, 'pending', ?, ?, ?, NULL, ?)
       ON CONFLICT (run_id) DO NOTHING`
    ).bind(runId, items.length, now.toISOString(), expiresAt, summary),
  ]

  for (const item of items) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO run_review_items (
           id, run_id, kind, position, source_phrase, detail, proposed_label,
           proposed_sku, proposed_quantity, proposed_customer_id,
           confidence_label, confidence_score, heuristic, reasons, alternatives,
           state, decision, resolved_sku, resolved_quantity,
           resolved_customer_id, resolved_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
                   NULL, NULL, NULL, NULL, NULL, ?)
         ON CONFLICT (run_id, kind, position) DO NOTHING`
      ).bind(
        crypto.randomUUID(),
        runId,
        item.kind,
        item.position,
        item.sourcePhrase,
        item.detail,
        item.proposedLabel,
        item.proposedSku,
        item.proposedQuantity,
        item.proposedCustomerId,
        item.confidenceLabel,
        item.confidenceScore,
        item.heuristic,
        JSON.stringify(item.reasons),
        JSON.stringify(item.alternatives),
        now.toISOString()
      )
    )
  }

  await env.DB.batch(statements)
  await insertReviewStep(env, runId, summary, now.toISOString())

  console.log(
    JSON.stringify({
      event: "review_opened",
      runId,
      step: REVIEW_STEP_KEY,
      items: items.length,
      expiresAt,
    })
  )

  return {
    state: "required",
    itemCount: items.length,
    expiresAt,
    timeoutMs: windowMs,
  }
}

function reviewWindowMs(env: Env, sourceKind: string): number {
  const configured =
    sourceKind === "custom"
      ? env.REVIEW_WINDOW_SECONDS_CUSTOM
      : env.REVIEW_WINDOW_SECONDS_CURATED

  const seconds = Number.parseFloat(configured ?? "")

  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : (sourceKind === "custom"
        ? DEFAULT_WINDOW_SECONDS.custom
        : DEFAULT_WINDOW_SECONDS.curated) * 1000
}

function remainingMs(expiresAt: string): number {
  return Math.max(1_000, Date.parse(expiresAt) - Date.now())
}

type CollectedItem = {
  kind: "customer" | "product" | "quantity" | "field"
  position: number
  sourcePhrase: string
  detail: string
  proposedLabel: string
  proposedSku: string | null
  proposedQuantity: number | null
  proposedCustomerId: string | null
  confidenceLabel: string
  confidenceScore: number
  heuristic: string
  reasons: string[]
  alternatives: ReviewAlternative[]
}

export type ReviewAlternative = {
  /** A SKU or a customer identifier; never a value the owner typed. */
  value: string
  label: string
  detail: string
  score: number
}

/** The run-level customer decision has no line of its own. */
const RUN_LEVEL_POSITION = -1

async function collectItems(env: Env, runId: string): Promise<CollectedItem[]> {
  const items: CollectedItem[] = []

  const [resolution, rfq, lines, matches] = await Promise.all([
    env.DB.prepare(
      `SELECT state, customer_id, confidence_label, confidence_score
         FROM run_customer_resolution WHERE run_id = ?`
    )
      .bind(runId)
      .first<{
        state: string
        customer_id: string | null
        confidence_label: string
        confidence_score: number
      }>(),
    env.DB.prepare(
      `SELECT company_name, contact_email, delivery_location
         FROM run_rfq WHERE run_id = ?`
    )
      .bind(runId)
      .first<{
        company_name: string | null
        contact_email: string | null
        delivery_location: string | null
      }>(),
    env.DB.prepare(
      `SELECT position, reference, description, quantity, unit,
              validation_state, validation_reason
         FROM run_rfq_line_items WHERE run_id = ? ORDER BY position ASC`
    )
      .bind(runId)
      .all<{
        position: number
        reference: string
        description: string
        quantity: number | null
        unit: string | null
        validation_state: string
        validation_reason: string | null
      }>(),
    env.DB.prepare(
      `SELECT position, state, sku, method, confidence_label, confidence_score,
              reason, alternatives
         FROM run_line_matches WHERE run_id = ? ORDER BY position ASC`
    )
      .bind(runId)
      .all<{
        position: number
        state: string
        sku: string | null
        method: string
        confidence_label: string
        confidence_score: number
        reason: string
        alternatives: string
      }>(),
  ])

  // 1. Identity. A run never creates a customer, so the question is always
  //    "which existing customer is this", never "shall I make one".
  if (
    !resolution ||
    resolution.state !== "resolved" ||
    !resolution.customer_id
  ) {
    items.push({
      kind: "customer",
      position: RUN_LEVEL_POSITION,
      sourcePhrase:
        rfq?.company_name ?? rfq?.contact_email ?? "No company was stated",
      detail:
        "Pricing needs a customer: the tier, the agreed prices, and the delivery location all come from that record.",
      proposedLabel: "No catalogue customer was resolved",
      proposedSku: null,
      proposedQuantity: null,
      proposedCustomerId: null,
      confidenceLabel: resolution?.confidence_label ?? "Review",
      confidenceScore: resolution?.confidence_score ?? 0,
      heuristic:
        "Identity scores below the acceptance threshold, or too close to the runner-up, stay unresolved rather than guessing.",
      reasons: [
        rfq?.contact_email
          ? `The request came from ${rfq.contact_email}, which no catalogue contact or domain claims.`
          : "The request states no contact address to identify a customer by.",
        "Creating a customer from model output is not available in this demo.",
      ],
      alternatives: await customerAlternatives(env, runId),
    })
  }

  const matchByPosition = new Map(
    matches.results.map((row) => [row.position, row])
  )

  // The proposal line is descriptive, not an instruction: the panel already
  // renders the SKU beside it, and the button next to it is what says
  // "accept". So the label is what the SKU *is*, read from the catalogue.
  const proposedNames = await catalogNames(
    env,
    matches.results.flatMap((row) =>
      row.state !== "accepted" && row.sku ? [row.sku] : []
    )
  )

  for (const line of lines.results) {
    const phrase = line.reference || line.description

    // 2. Quantity and extracted fields. One item per line: a line missing a
    //    usable quantity is asked as a quantity; anything else the business
    //    rules rejected is asked as the extracted field it came from.
    if (line.validation_state !== "accepted") {
      const needsQuantity = line.quantity === null || line.quantity <= 0
      const reasons = (line.validation_reason ?? "")
        .split(". ")
        .map((reason) => reason.trim())
        .filter((reason) => reason.length > 0)
        .map((reason) => (reason.endsWith(".") ? reason : `${reason}.`))

      items.push({
        kind: needsQuantity ? "quantity" : "field",
        position: line.position,
        sourcePhrase: phrase,
        detail: needsQuantity
          ? `“${line.description}” — no usable quantity survived validation${line.unit ? `, stated in ${line.unit}` : ""}.`
          : `“${line.description}” — extracted, but one field did not survive validation.`,
        proposedLabel: needsQuantity
          ? "No quantity to price"
          : "Use the line exactly as extracted",
        proposedSku: null,
        proposedQuantity: null,
        proposedCustomerId: null,
        confidenceLabel: "Review",
        confidenceScore: 0,
        heuristic:
          "Business validation is a hard rule, not a score: a line that fails it is never priced on a guess.",
        reasons:
          reasons.length > 0
            ? reasons
            : ["This line did not pass business validation."],
        alternatives: [],
      })
    }

    // 3. The product decision.
    const match = matchByPosition.get(line.position)

    if (match && match.state !== "accepted") {
      const alternatives = readMatchAlternatives(match.alternatives)

      items.push({
        kind: "product",
        position: line.position,
        sourcePhrase: phrase,
        detail: `“${line.description}” — the catalogue decision for this line is not certain enough to price.`,
        proposedLabel: match.sku
          ? (proposedNames.get(match.sku) ?? match.sku)
          : "No catalogue product could be proposed",
        proposedSku: match.sku,
        proposedQuantity: null,
        proposedCustomerId: null,
        confidenceLabel: match.confidence_label,
        confidenceScore: match.confidence_score,
        heuristic:
          match.method === "superseded"
            ? "A superseded article number always goes to review, whatever its successor scores."
            : "Demo heuristics, not calibrated probabilities: a match is accepted only when the winner clears the strength threshold and leads the runner-up by the configured gap.",
        reasons: [match.reason],
        alternatives: alternatives.slice(0, 3),
      })
    }
  }

  return items
}

/** Catalogue names for proposed SKUs, so a proposal reads as a product. */
async function catalogNames(
  env: Env,
  skus: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(skus)]
  if (unique.length === 0) return new Map()

  const rows = await env.DB.prepare(
    `SELECT sku, name FROM catalog_products
      WHERE sku IN (${unique.map(() => "?").join(", ")})`
  )
    .bind(...unique)
    .all<{ sku: string; name: string }>()

  return new Map(rows.results.map((row) => [row.sku, row.name]))
}

function readMatchAlternatives(raw: string): ReviewAlternative[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((entry) => {
      const value = entry as Record<string, unknown>
      const sku = typeof value.sku === "string" ? value.sku : null
      if (!sku) return []

      return [
        {
          value: sku,
          label: typeof value.name === "string" ? value.name : sku,
          detail: typeof value.reason === "string" ? value.reason : "",
          score: typeof value.score === "number" ? value.score : 0,
        },
      ]
    })
  } catch {
    return []
  }
}

/** The customers resolution scored highest, read back from its own evidence. */
async function customerAlternatives(
  env: Env,
  runId: string
): Promise<ReviewAlternative[]> {
  const row = await env.DB.prepare(
    `SELECT payload FROM run_step_evidence
      WHERE run_id = ? AND step_key = 'resolve-customer' AND kind = 'customer'`
  )
    .bind(runId)
    .first<{ payload: string }>()

  if (!row) return []

  try {
    const parsed = JSON.parse(row.payload) as {
      candidates?: { customerId?: string; name?: string; score?: number }[]
    }

    return (parsed.candidates ?? []).flatMap((candidate) =>
      candidate.customerId
        ? [
            {
              value: candidate.customerId,
              label: candidate.name ?? candidate.customerId,
              detail: "Scored by customer resolution, below the threshold.",
              score: candidate.score ?? 0,
            },
          ]
        : []
    )
  } catch {
    return []
  }
}

function describeItems(items: CollectedItem[]): string {
  const counts = {
    customer: items.filter((item) => item.kind === "customer").length,
    product: items.filter((item) => item.kind === "product").length,
    quantity: items.filter((item) => item.kind === "quantity").length,
    field: items.filter((item) => item.kind === "field").length,
  }

  const parts: string[] = []
  if (counts.customer > 0) parts.push("the customer")
  if (counts.product > 0) {
    parts.push(
      `${counts.product} product ${plural(counts.product, "match", "matches")}`
    )
  }
  if (counts.quantity > 0) {
    parts.push(
      `${counts.quantity} ${plural(counts.quantity, "quantity", "quantities")}`
    )
  }
  if (counts.field > 0) {
    parts.push(
      `${counts.field} extracted ${plural(counts.field, "field", "fields")}`
    )
  }

  return `Waiting for the owner to confirm ${listOf(parts)}.`
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "this run"
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export type ReviewItemProjection = {
  id: string
  kind: string
  position: number
  sourcePhrase: string
  detail: string
  proposal: {
    label: string
    sku: string | null
    quantity: number | null
    customerId: string | null
  }
  confidence: { label: string; score: number; heuristic: string }
  reasons: string[]
  alternatives: ReviewAlternative[]
  state: string
  decision: string | null
  resolved: {
    sku: string | null
    quantity: number | null
    customerId: string | null
    at: string | null
  }
}

export type ReviewProjection = {
  stepKey: string
  state: ReviewState
  openedAt: string | null
  expiresAt: string | null
  decidedAt: string | null
  summary: string | null
  itemCount: number
  resolvedCount: number
  /** True only when every item is resolved and the window is still open. */
  canApprove: boolean
  note: string
  items: ReviewItemProjection[]
}

const REVIEW_NOTE =
  "Review is owner-only: the run URL alone grants no authority. Corrections choose between records that already exist; no product or customer is created here."

export async function loadReviewEvidence(
  env: Env,
  runId: string
): Promise<ReviewProjection> {
  const review = await loadReviewRow(env, runId)

  if (!review) {
    return {
      stepKey: REVIEW_STEP_KEY,
      state: "not_required",
      openedAt: null,
      expiresAt: null,
      decidedAt: null,
      summary: null,
      itemCount: 0,
      resolvedCount: 0,
      canApprove: false,
      note: REVIEW_NOTE,
      items: [],
    }
  }

  const rows = await env.DB.prepare(
    `SELECT id, kind, position, source_phrase, detail, proposed_label,
            proposed_sku, proposed_quantity, proposed_customer_id,
            confidence_label, confidence_score, heuristic, reasons,
            alternatives, state, decision, resolved_sku, resolved_quantity,
            resolved_customer_id, resolved_at
       FROM run_review_items WHERE run_id = ?
      ORDER BY position ASC, kind ASC`
  )
    .bind(runId)
    .all<ItemRow>()

  const items = rows.results.map(projectItem)
  const resolvedCount = items.filter((item) => item.state === "resolved").length
  // A pending review whose window has closed reads as expired to everyone,
  // whether or not anything has written that state down yet.
  const state = effectiveState(review)

  return {
    stepKey: REVIEW_STEP_KEY,
    state,
    openedAt: review.opened_at,
    expiresAt: review.expires_at,
    decidedAt: review.decided_at,
    summary: review.summary,
    itemCount: review.item_count,
    resolvedCount,
    canApprove:
      state === "pending" && resolvedCount === items.length && items.length > 0,
    note: REVIEW_NOTE,
    items,
  }
}

function projectItem(row: ItemRow): ReviewItemProjection {
  return {
    id: row.id,
    kind: row.kind,
    position: row.position,
    sourcePhrase: row.source_phrase,
    detail: row.detail,
    proposal: {
      label: row.proposed_label,
      sku: row.proposed_sku,
      quantity: row.proposed_quantity,
      customerId: row.proposed_customer_id,
    },
    confidence: {
      label: row.confidence_label,
      score: row.confidence_score,
      heuristic: row.heuristic,
    },
    reasons: readStrings(row.reasons),
    alternatives: readAlternatives(row.alternatives),
    state: row.state,
    decision: row.decision,
    resolved: {
      sku: row.resolved_sku,
      quantity: row.resolved_quantity,
      customerId: row.resolved_customer_id,
      at: row.resolved_at,
    },
  }
}

function readStrings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : []
  } catch {
    return []
  }
}

function readAlternatives(raw: string): ReviewAlternative[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((entry) => {
      const value = entry as Record<string, unknown>
      return typeof value.value === "string"
        ? [
            {
              value: value.value,
              label:
                typeof value.label === "string" ? value.label : value.value,
              detail: typeof value.detail === "string" ? value.detail : "",
              score: typeof value.score === "number" ? value.score : 0,
            },
          ]
        : []
    })
  } catch {
    return []
  }
}

async function loadReviewRow(
  env: Env,
  runId: string
): Promise<ReviewRow | null> {
  return await env.DB.prepare(
    `SELECT state, item_count, opened_at, expires_at, decided_at, summary
       FROM run_reviews WHERE run_id = ?`
  )
    .bind(runId)
    .first<ReviewRow>()
}

function effectiveState(review: ReviewRow): ReviewState {
  if (review.state !== "pending") return review.state as ReviewState
  return Date.parse(review.expires_at) <= Date.now() ? "expired" : "pending"
}

/** What the workflow reads when it wakes up. The event itself proves nothing. */
export async function readReviewState(
  env: Env,
  runId: string
): Promise<ReviewState> {
  const review = await loadReviewRow(env, runId)
  return review ? effectiveState(review) : "not_required"
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                   */
/* -------------------------------------------------------------------------- */

export type DecisionInput = {
  itemId: string
  action: "accept" | "alternative" | "catalog" | "quantity" | "customer"
  sku?: unknown
  quantity?: unknown
  customerId?: unknown
}

export type DecisionOutcome =
  | { state: "recorded"; review: ReviewProjection }
  | { state: "invalid"; message: string }
  | { state: "closed"; review: ReviewProjection; message: string }

/**
 * Records the owner's corrections. Nothing here releases the workflow: the
 * decisions are persisted, and approval is a separate, explicit act.
 */
export async function recordDecisions(
  env: Env,
  runId: string,
  decisions: DecisionInput[]
): Promise<DecisionOutcome> {
  const review = await loadReviewRow(env, runId)

  if (!review) {
    return {
      state: "invalid",
      message: "This run has nothing waiting for review",
    }
  }

  const state = effectiveState(review)

  if (state !== "pending") {
    return {
      state: "closed",
      review: await loadReviewEvidence(env, runId),
      message: closedMessage(state),
    }
  }

  if (decisions.length === 0) {
    return { state: "invalid", message: "No review decisions were submitted" }
  }

  const rows = await env.DB.prepare(
    `SELECT id, kind, position, source_phrase, detail, proposed_label,
            proposed_sku, proposed_quantity, proposed_customer_id,
            confidence_label, confidence_score, heuristic, reasons,
            alternatives, state, decision, resolved_sku, resolved_quantity,
            resolved_customer_id, resolved_at
       FROM run_review_items WHERE run_id = ?`
  )
    .bind(runId)
    .all<ItemRow>()

  const byId = new Map(rows.results.map((row) => [row.id, row]))
  const statements: D1PreparedStatement[] = []
  const now = new Date().toISOString()

  for (const decision of decisions) {
    const row = byId.get(decision.itemId)

    if (!row) {
      return {
        state: "invalid",
        message: "A decision referenced an item that is not under review",
      }
    }

    const resolved = await resolveDecision(env, row, decision)

    if (resolved.state === "invalid") {
      return { state: "invalid", message: resolved.message }
    }

    // The guard matters for a correction that arrives while the review is
    // being decided: an item may not become resolved after the decision that
    // read it, or the projection would show a value that was never applied.
    statements.push(
      env.DB.prepare(
        `UPDATE run_review_items
            SET state = 'resolved', decision = ?, resolved_sku = ?,
                resolved_quantity = ?, resolved_customer_id = ?,
                resolved_at = ?
          WHERE id = ? AND run_id = ?
            AND (SELECT state FROM run_reviews WHERE run_id = ?) = 'pending'`
      ).bind(
        resolved.decision,
        resolved.sku,
        resolved.quantity,
        resolved.customerId,
        now,
        row.id,
        runId,
        runId
      )
    )
  }

  await env.DB.batch(statements)

  console.log(
    JSON.stringify({
      event: "review_decisions_recorded",
      runId,
      step: REVIEW_STEP_KEY,
      decisions: decisions.length,
    })
  )

  return { state: "recorded", review: await loadReviewEvidence(env, runId) }
}

type ResolvedDecision =
  | {
      state: "ok"
      decision: string
      sku: string | null
      quantity: number | null
      customerId: string | null
    }
  | { state: "invalid"; message: string }

/**
 * One decision, checked against the catalogue rather than against the request.
 * Every accepted value is an identifier that already exists.
 */
async function resolveDecision(
  env: Env,
  row: ItemRow,
  decision: DecisionInput
): Promise<ResolvedDecision> {
  const alternatives = readAlternatives(row.alternatives)

  if (row.kind === "customer") {
    if (decision.action !== "customer" && decision.action !== "alternative") {
      return {
        state: "invalid",
        message: "The customer decision needs an existing customer",
      }
    }

    const customerId =
      typeof decision.customerId === "string" ? decision.customerId.trim() : ""

    if (!customerId) {
      return { state: "invalid", message: "A customer identifier is required" }
    }

    if (
      decision.action === "alternative" &&
      !alternatives.some((entry) => entry.value === customerId)
    ) {
      return {
        state: "invalid",
        message: "That customer is not one of the offered alternatives",
      }
    }

    const customer = await env.DB.prepare(
      `SELECT id FROM catalog_customers WHERE id = ?`
    )
      .bind(customerId)
      .first<{ id: string }>()

    if (!customer) {
      return {
        state: "invalid",
        message: "That customer is not in the catalogue",
      }
    }

    return {
      state: "ok",
      decision: "selected_customer",
      sku: null,
      quantity: null,
      customerId,
    }
  }

  if (row.kind === "quantity") {
    if (decision.action !== "quantity") {
      return {
        state: "invalid",
        message: "This line needs a corrected quantity",
      }
    }

    const quantity = Number(decision.quantity)

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_LINE_QUANTITY
    ) {
      return {
        state: "invalid",
        message: `A quantity must be a whole number between 1 and ${MAX_LINE_QUANTITY}`,
      }
    }

    return {
      state: "ok",
      decision: "corrected_quantity",
      sku: null,
      quantity,
      customerId: null,
    }
  }

  if (row.kind === "field") {
    if (decision.action !== "accept") {
      return {
        state: "invalid",
        message: "An extracted field can only be confirmed as it stands",
      }
    }

    return {
      state: "ok",
      decision: "confirmed_extraction",
      sku: null,
      quantity: null,
      customerId: null,
    }
  }

  // A product decision. Accepting uses the proposal; the other two paths name a
  // SKU, which must be an active catalogue product either way.
  const sku =
    decision.action === "accept"
      ? row.proposed_sku
      : typeof decision.sku === "string"
        ? decision.sku.trim().toUpperCase()
        : ""

  if (!sku) {
    return {
      state: "invalid",
      message:
        decision.action === "accept"
          ? "This line has no proposed product to accept"
          : "A catalogue article number is required",
    }
  }

  if (
    decision.action === "alternative" &&
    !alternatives.some((entry) => entry.value === sku)
  ) {
    return {
      state: "invalid",
      message: "That product is not one of the offered alternatives",
    }
  }

  const product = await env.DB.prepare(
    `SELECT sku FROM catalog_products WHERE sku = ? AND status = 'active'`
  )
    .bind(sku)
    .first<{ sku: string }>()

  if (!product) {
    return {
      state: "invalid",
      message: "That article number is not an active catalogue product",
    }
  }

  return {
    state: "ok",
    decision:
      decision.action === "accept"
        ? "accepted_proposal"
        : decision.action === "alternative"
          ? "chose_alternative"
          : "chose_catalog",
    sku,
    quantity: null,
    customerId: null,
  }
}

export type ReviewDecision = "approve" | "reject"

export type ReviewSettlement =
  | { state: "settled"; decision: ReviewDecision; review: ReviewProjection }
  | { state: "incomplete"; review: ReviewProjection; message: string }
  | { state: "closed"; review: ReviewProjection; message: string }
  | { state: "absent" }

/**
 * The single transition out of `pending`.
 *
 * Approval applies the owner's corrections to the run's own tables — the
 * quantity a line is priced with, the product a line is matched to, the
 * customer the run resolved to — so the workflow resumes through exactly the
 * same deterministic pricing path with corrected facts. It then records the
 * learned wording, and only afterwards releases the workflow.
 */
export async function settleReview(
  env: Env,
  runId: string,
  decision: ReviewDecision
): Promise<ReviewSettlement> {
  const review = await loadReviewRow(env, runId)
  if (!review) return { state: "absent" }

  const state = effectiveState(review)

  if (state !== "pending") {
    // Includes the expired case: mark it terminal on the way past, so a
    // window that closed while nobody was looking still ends somewhere stable.
    if (review.state === "pending") await expireReview(env, runId)

    return {
      state: "closed",
      review: await loadReviewEvidence(env, runId),
      message: closedMessage(state),
    }
  }

  const items = await env.DB.prepare(
    `SELECT id, kind, position, source_phrase, detail, proposed_label,
            proposed_sku, proposed_quantity, proposed_customer_id,
            confidence_label, confidence_score, heuristic, reasons,
            alternatives, state, decision, resolved_sku, resolved_quantity,
            resolved_customer_id, resolved_at
       FROM run_review_items WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(runId)
    .all<ItemRow>()

  const unresolved = items.results.filter((item) => item.state !== "resolved")

  if (decision === "approve" && unresolved.length > 0) {
    return {
      state: "incomplete",
      review: await loadReviewEvidence(env, runId),
      message: `${unresolved.length} of ${items.results.length} decisions are still open, so this review cannot be approved yet`,
    }
  }

  const now = new Date().toISOString()

  // The conditional update is the mutex. Whoever changes the row owns the
  // transition; everyone else reads the outcome it produced.
  const claimed = await env.DB.prepare(
    `UPDATE run_reviews
        SET state = ?, decided_at = ?, summary = ?
      WHERE run_id = ? AND state = 'pending'`
  )
    .bind(
      decision === "approve" ? "approved" : "rejected",
      now,
      decision === "approve"
        ? `Owner approved ${items.results.length} ${plural(items.results.length, "decision", "decisions")}.`
        : "Owner rejected this review, so the run stops here.",
      runId
    )
    .run()

  if (claimed.meta.changes !== 1) {
    const current = await loadReviewEvidence(env, runId)

    return {
      state: "closed",
      review: current,
      message: closedMessage(current.state),
    }
  }

  if (decision === "approve") {
    await applyCorrections(env, runId, items.results)
    await learnAliases(env, runId, items.results)
    await completeReviewStep(env, runId, items.results.length, now)
  } else {
    await stopAtReviewStep(
      env,
      runId,
      "Owner rejected this review, so the run stops here. Nothing was priced or delivered.",
      "review_rejected",
      now
    )
  }

  console.log(
    JSON.stringify({
      event: decision === "approve" ? "review_approved" : "review_rejected",
      runId,
      step: REVIEW_STEP_KEY,
      items: items.results.length,
    })
  )

  return {
    state: "settled",
    decision,
    review: await loadReviewEvidence(env, runId),
  }
}

function closedMessage(state: ReviewState): string {
  switch (state) {
    case "approved":
      return "This review was already approved"
    case "rejected":
      return "This review was already rejected"
    case "expired":
      return "This review window has closed"
    default:
      return "This run has nothing waiting for review"
  }
}

/** Writes the owner's corrections into the facts pricing reads. */
async function applyCorrections(
  env: Env,
  runId: string,
  items: ItemRow[]
): Promise<void> {
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []

  for (const item of items) {
    if (item.kind === "customer" && item.resolved_customer_id) {
      const chosen = await env.DB.prepare(
        `SELECT
           (SELECT id FROM catalog_customer_contacts
             WHERE customer_id = ?1 ORDER BY id ASC LIMIT 1) AS contact_id,
           (SELECT id FROM catalog_customer_locations
             WHERE customer_id = ?1 ORDER BY id ASC LIMIT 1) AS location_id`
      )
        .bind(item.resolved_customer_id)
        .first<{ contact_id: string | null; location_id: string | null }>()

      statements.push(
        env.DB.prepare(
          `INSERT INTO run_customer_resolution
             (run_id, state, customer_id, contact_id, location_id,
              confidence_label, confidence_score, created_at)
           VALUES (?, 'resolved', ?, ?, ?, 'High', 1, ?)
           ON CONFLICT (run_id) DO UPDATE SET
             state = 'resolved',
             customer_id = excluded.customer_id,
             contact_id = excluded.contact_id,
             location_id = excluded.location_id,
             confidence_label = 'High',
             confidence_score = 1`
        ).bind(
          runId,
          item.resolved_customer_id,
          chosen?.contact_id ?? null,
          chosen?.location_id ?? null,
          now
        )
      )
    }

    if (item.kind === "quantity" && item.resolved_quantity !== null) {
      statements.push(
        env.DB.prepare(
          `UPDATE run_rfq_line_items
              SET quantity = ?, validation_state = 'accepted',
                  validation_reason = 'Quantity confirmed by the owner during review.'
            WHERE run_id = ? AND position = ?`
        ).bind(item.resolved_quantity, runId, item.position)
      )
    }

    if (item.kind === "field") {
      statements.push(
        env.DB.prepare(
          `UPDATE run_rfq_line_items
              SET validation_state = 'accepted',
                  validation_reason = 'Confirmed by the owner during review, exactly as extracted.'
            WHERE run_id = ? AND position = ?`
        ).bind(runId, item.position)
      )
    }

    if (item.kind === "product" && item.resolved_sku) {
      const chosenBySearch = item.decision === "chose_catalog"
      const reason =
        item.decision === "accepted_proposal"
          ? `The owner accepted the proposed match to ${item.resolved_sku} during review.`
          : chosenBySearch
            ? `The owner chose ${item.resolved_sku} from the complete catalogue during review.`
            : `The owner chose the alternative ${item.resolved_sku} during review.`

      statements.push(
        env.DB.prepare(
          `UPDATE run_line_matches
              SET state = 'accepted', sku = ?, method = 'owner_review',
                  confidence_label = 'High', confidence_score = 1,
                  winner_gap = 1, reason = ?
            WHERE run_id = ? AND position = ?`
        ).bind(item.resolved_sku, reason, runId, item.position)
      )
    }
  }

  if (statements.length > 0) await env.DB.batch(statements)
}

/**
 * Learning, kept inside one anonymous browser workspace.
 *
 * A product the owner confirmed for a phrase becomes wording that workspace
 * records for that customer, so a later run from the same browser recognises it
 * deterministically. It is written to `workspace_product_aliases` and nowhere
 * else: the seeded catalogue is untouched, and a run from another workspace
 * never reads these rows.
 */
async function learnAliases(
  env: Env,
  runId: string,
  items: ItemRow[]
): Promise<void> {
  const run = await env.DB.prepare(
    `SELECT r.workspace_hash AS workspace_hash, c.customer_id AS customer_id,
            c.state AS customer_state
       FROM runs r
       LEFT JOIN run_customer_resolution c ON c.run_id = r.id
      WHERE r.id = ?`
  )
    .bind(runId)
    .first<{
      workspace_hash: string | null
      customer_id: string | null
      customer_state: string | null
    }>()

  // Wording is private to a customer, so an unresolved run has nobody to learn
  // for, and a browser without a workspace token has nowhere to keep it.
  if (!run?.workspace_hash || !run.customer_id) return

  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []

  for (const item of items) {
    if (item.kind !== "product" || !item.resolved_sku) continue

    const normalised = normaliseText(item.source_phrase)
    if (normalised.length === 0) continue

    statements.push(
      env.DB.prepare(
        `INSERT INTO workspace_product_aliases
           (workspace_hash, customer_id, normalised, alias, sku, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_hash, customer_id, normalised, sku)
           DO NOTHING`
      ).bind(
        run.workspace_hash,
        run.customer_id,
        normalised,
        item.source_phrase,
        item.resolved_sku,
        now
      )
    )
  }

  if (statements.length === 0) return

  await env.DB.batch(statements)

  console.log(
    JSON.stringify({
      event: "workspace_aliases_learned",
      runId,
      aliases: statements.length,
    })
  )
}

/** The window closed with nothing decided. A terminal outcome, not a retry. */
export async function expireReview(env: Env, runId: string): Promise<boolean> {
  const now = new Date().toISOString()

  const claimed = await env.DB.prepare(
    `UPDATE run_reviews
        SET state = 'expired', decided_at = ?,
            summary = 'The review window closed before a decision was made.'
      WHERE run_id = ? AND state = 'pending'`
  )
    .bind(now, runId)
    .run()

  if (claimed.meta.changes !== 1) return false

  await stopAtReviewStep(
    env,
    runId,
    "The review window closed before a decision was made, so this run was never priced.",
    "review_expired",
    now
  )

  console.log(
    JSON.stringify({ event: "review_expired", runId, step: REVIEW_STEP_KEY })
  )

  return true
}

/* -------------------------------------------------------------------------- */
/* Searching, for a shortlist that was not enough                             */
/* -------------------------------------------------------------------------- */

export type CatalogSearchResult = {
  sku: string
  name: string
  category: string
  manufacturer: string
  unit: string
}

export async function searchReviewCatalog(
  env: Env,
  query: string
): Promise<CatalogSearchResult[]> {
  const term = query.trim()
  if (term.length < 2) return []

  const like = `%${term.toLowerCase()}%`

  const rows = await env.DB.prepare(
    `SELECT sku, name, category, manufacturer, unit
       FROM catalog_products
      WHERE status = 'active'
        AND (lower(sku) LIKE ?1 OR lower(name) LIKE ?1
             OR lower(description) LIKE ?1 OR lower(manufacturer) LIKE ?1)
      ORDER BY sku ASC
      LIMIT 20`
  )
    .bind(like)
    .all<CatalogSearchResult>()

  return rows.results
}

export type CustomerSearchResult = {
  customerId: string
  name: string
  tier: string
  city: string | null
}

export async function searchReviewCustomers(
  env: Env,
  query: string
): Promise<CustomerSearchResult[]> {
  const term = query.trim()
  const like = `%${term.toLowerCase()}%`

  const rows = await env.DB.prepare(
    `SELECT c.id AS customerId, c.name AS name, c.tier AS tier,
            (SELECT l.city FROM catalog_customer_locations l
              WHERE l.customer_id = c.id ORDER BY l.id ASC LIMIT 1) AS city
       FROM catalog_customers c
      WHERE ?2 = '' OR lower(c.name) LIKE ?1 OR lower(c.id) LIKE ?1
      ORDER BY c.name ASC
      LIMIT 20`
  )
    .bind(like, term.toLowerCase())
    .all<CustomerSearchResult>()

  return rows.results
}

/* -------------------------------------------------------------------------- */
/* The graph node                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Inserts the conditional node into the linear graph, between the product
 * decisions it questions and the pricing it blocks. Later steps move down by
 * one so the sequence a reader sees stays strictly top-down.
 */
async function insertReviewStep(
  env: Env,
  runId: string,
  summary: string,
  now: string
): Promise<void> {
  const anchor = await env.DB.prepare(
    `SELECT position FROM run_steps WHERE run_id = ? AND step_key = ?`
  )
    .bind(runId, MATCH_PRODUCTS_STEP_KEY)
    .first<{ position: number }>()

  const position = (anchor?.position ?? 5) + 1

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE run_steps SET position = position + 1, updated_at = ?
        WHERE run_id = ? AND position >= ?`
    ).bind(now, runId, position),
    env.DB.prepare(
      `INSERT INTO run_steps (
         id, run_id, step_key, position, title, status, summary,
         started_at, completed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'review_required', ?, ?, NULL, ?)
       ON CONFLICT (run_id, step_key) DO UPDATE SET
         status = 'review_required',
         summary = excluded.summary,
         updated_at = excluded.updated_at`
    ).bind(
      crypto.randomUUID(),
      runId,
      REVIEW_STEP_KEY,
      position,
      REVIEW_STEP_TITLE,
      summary,
      now,
      now
    ),
    // The node that is actually blocked says so, rather than leaving its
    // generic waiting copy in place while the graph stops above it.
    env.DB.prepare(
      `UPDATE run_steps
          SET summary = ?, updated_at = ?
        WHERE run_id = ? AND step_key = 'build-estimate' AND status = 'waiting'`
    ).bind(`Waiting for owner review before pricing. ${summary}`, now, runId),
    env.DB.prepare(
      `UPDATE runs SET workflow_state = 'awaiting_review', updated_at = ?
        WHERE id = ?`
    ).bind(now, runId),
  ])
}

async function completeReviewStep(
  env: Env,
  runId: string,
  itemCount: number,
  now: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'complete', summary = ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ?`
    ).bind(
      `Owner confirmed ${itemCount} ${plural(itemCount, "decision", "decisions")}; the run continues to pricing.`,
      now,
      now,
      runId,
      REVIEW_STEP_KEY
    ),
    env.DB.prepare(
      `UPDATE runs SET workflow_state = 'review_approved', updated_at = ?
        WHERE id = ?`
    ).bind(now, runId),
  ])
}

/**
 * A rejected or expired review ends the run where it stands. The later nodes
 * keep their waiting state — the graph simply stops, as the design requires,
 * and there is no retry.
 */
async function stopAtReviewStep(
  env: Env,
  runId: string,
  summary: string,
  workflowState: string,
  now: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'error', summary = ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ?`
    ).bind(summary, now, now, runId, REVIEW_STEP_KEY),
    env.DB.prepare(
      `UPDATE runs SET status = 'error', workflow_state = ?, updated_at = ?
        WHERE id = ?`
    ).bind(workflowState, now, runId),
  ])
}

async function failStep(
  env: Env,
  runId: string,
  message: string
): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE run_steps
          SET status = 'error', summary = ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ?`
    ).bind(message, now, now, runId, REVIEW_STEP_KEY),
    env.DB.prepare(
      `UPDATE runs SET status = 'error', workflow_state = 'failed', updated_at = ?
        WHERE id = ?`
    ).bind(now, runId),
  ])
}
