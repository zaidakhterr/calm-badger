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

import { z } from "zod"

import { readConfig, type AppConfig } from "./env"
import { STORED_MATCH_ALTERNATIVES_SCHEMA } from "./match-products"
import {
  CUSTOMER_EVIDENCE_KIND,
  CUSTOMER_EVIDENCE_SCHEMA,
  RESOLVE_CUSTOMER_STEP_KEY,
} from "./resolve-customer"
import { retentionDeadline } from "./retention-policy"
import { MAX_LINE_QUANTITY } from "./rfq-extraction"
import { createRunStepRecorder } from "./run-steps"

export const REVIEW_STEP_KEY = "review-required"
export const REVIEW_STEP_TITLE = "Review required"

/** The event type the Worker delivers to a hibernating workflow instance. */
export const REVIEW_EVENT_TYPE = "owner-review"

/* -------------------------------------------------------------------------- */
/* The contracts this node owns                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every state a review can be in. `not_required` is the state of a run that
 * never opened one, so it is also what a state this build does not recognise
 * reads as: nothing here is waiting for anybody.
 */
export const REVIEW_STATE_SCHEMA = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected",
  "expired",
])

export type ReviewState = z.infer<typeof REVIEW_STATE_SCHEMA>

/** The four kinds of uncertainty a run can raise, and nothing else. */
export const REVIEW_ITEM_KIND_SCHEMA = z.enum([
  "customer",
  "product",
  "quantity",
  "field",
])

export type ReviewItemKind = z.infer<typeof REVIEW_ITEM_KIND_SCHEMA>

/**
 * One alternative the owner may choose instead of the proposal.
 *
 * The identifier is required — an alternative that names no record is not an
 * offer, and there is nothing to select. What it reads as is enrichment: an
 * entry an earlier build wrote without a label still offers its identifier
 * rather than disappearing from the list.
 */
export const REVIEW_ALTERNATIVE_SCHEMA = z
  .object({
    /** A SKU or a customer identifier; never a value the owner typed. */
    value: z.string(),
    label: z.string().nullable().catch(null),
    detail: z.string().catch(""),
    score: z.number().catch(0),
  })
  .transform((entry) => ({
    value: entry.value,
    label: entry.label ?? entry.value,
    detail: entry.detail,
    score: entry.score,
  }))

export type ReviewAlternative = z.infer<typeof REVIEW_ALTERNATIVE_SCHEMA>

/**
 * One correction as the owner's browser submits it. The Worker parses the
 * request body with this schema, so a decision that reaches `recordDecisions`
 * already names a known action and carries values of the right kind. Whether
 * those values exist is the catalogue's answer, and it is given below.
 */
export const REVIEW_DECISION_SCHEMA = z.object({
  itemId: z.string(),
  action: z.enum(["accept", "alternative", "catalog", "quantity", "customer"]),
  sku: z.string().optional(),
  quantity: z.number().optional(),
  customerId: z.string().optional(),
})

export type DecisionInput = z.infer<typeof REVIEW_DECISION_SCHEMA>

/**
 * The decisions request body, as a list before any entry is a decision. The
 * two stages are two different answers: a body that carries no list at all was
 * not a submission, while a list holding something unrecognised names the
 * entry that cannot be applied.
 */
export const REVIEW_DECISIONS_BODY_SCHEMA = z.object({
  decisions: z.array(z.json()),
})

/**
 * The body that settles the review. Approving or rejecting is the whole
 * vocabulary; anything else is not a decision this node knows how to make.
 */
export const REVIEW_SETTLEMENT_BODY_SCHEMA = z.object({
  action: z.enum(["approve", "reject"]),
})

/**
 * How a product line was decided. Anything else — including a decision word an
 * earlier build wrote — reads as the alternative, which is how the stored
 * reason already describes it.
 */
const PRODUCT_DECISION_SCHEMA = z
  .enum(["accepted_proposal", "chose_alternative", "chose_catalog"])
  .catch("chose_alternative")

/** A JSON text column of this module's, decoded before it is parsed. */
const STORED_TEXT_SCHEMA = z.string().transform((raw, ctx) => {
  try {
    const decoded: unknown = JSON.parse(raw)
    return decoded
  } catch {
    ctx.addIssue({ code: "custom", message: "The column is not JSON text." })
    return z.NEVER
  }
})

/** The `reasons` column: the sentences this node wrote for one item. */
const STORED_REASONS_SCHEMA = STORED_TEXT_SCHEMA.pipe(z.array(z.string()))

/** The `alternatives` column: the offers this node recorded for one item. */
const STORED_REVIEW_ALTERNATIVES_SCHEMA = STORED_TEXT_SCHEMA.pipe(
  z.array(REVIEW_ALTERNATIVE_SCHEMA)
)

/** The Resolve customer evidence row, read here for its scored candidates. */
const STORED_CUSTOMER_EVIDENCE_SCHEMA = STORED_TEXT_SCHEMA.pipe(
  CUSTOMER_EVIDENCE_SCHEMA
)

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
      await createRunStepRecorder(env, runId, REVIEW_STEP_KEY).fail(message)
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
  const windowMs = reviewWindowMs(
    readConfig(env),
    run?.source_kind ?? "curated"
  )
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

  // The conditional node goes into the linear graph between the product
  // decisions it questions and the pricing it blocks; later steps move down by
  // one so the sequence a reader sees stays strictly top-down.
  await createRunStepRecorder(
    env,
    runId,
    REVIEW_STEP_KEY
  ).insertConditionalStep({
    title: REVIEW_STEP_TITLE,
    summary,
    blocks: {
      stepKey: "build-estimate",
      summary: `Waiting for owner review before pricing. ${summary}`,
    },
  })

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

function reviewWindowMs(config: AppConfig, sourceKind: string): number {
  const seconds =
    sourceKind === "custom"
      ? config.reviewWindowSecondsCustom
      : config.reviewWindowSecondsCurated

  return seconds * 1000
}

function remainingMs(expiresAt: string): number {
  return Math.max(1_000, Date.parse(expiresAt) - Date.now())
}

type CollectedItem = {
  kind: ReviewItemKind
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
      detail: "The system needs a customer before it can calculate a price.",
      proposedLabel: "No customer found",
      proposedSku: null,
      proposedQuantity: null,
      proposedCustomerId: null,
      confidenceLabel: resolution?.confidence_label ?? "Review",
      confidenceScore: resolution?.confidence_score ?? 0,
      heuristic:
        "The customer score did not meet the automatic acceptance rules.",
      reasons: [
        rfq?.contact_email
          ? `No customer uses the email address ${rfq.contact_email}.`
          : "The request does not contain a contact email address.",
        "This demo cannot create a customer.",
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
          ? `The line does not have a valid quantity${line.unit ? ` in ${line.unit}` : ""}.`
          : "The line contains a value that did not pass validation.",
        proposedLabel: needsQuantity
          ? "Enter a quantity"
          : "Use the extracted value",
        proposedSku: null,
        proposedQuantity: null,
        proposedCustomerId: null,
        confidenceLabel: "Review",
        confidenceScore: 0,
        heuristic:
          "A line that fails validation cannot continue without review.",
        reasons:
          reasons.length > 0 ? reasons : ["The line did not pass validation."],
        alternatives: [],
      })
    }

    // 3. The product decision.
    const match = matchByPosition.get(line.position)

    if (match && match.state !== "accepted") {
      const alternatives = matchAlternatives(match.alternatives)

      items.push({
        kind: "product",
        position: line.position,
        sourcePhrase: phrase,
        detail:
          "The product match did not meet the automatic acceptance rules.",
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
            ? "An old product number always requires review."
            : "The proposed product must meet the score and score-gap limits.",
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

/**
 * Alternatives as `match-products` stores them, offered here by SKU. The
 * column is that step's contract, so its schema comes from there; what an
 * unreadable one means is this node's decision, and it means no alternatives
 * for that line rather than a review that cannot be opened.
 */
function matchAlternatives(raw: string): ReviewAlternative[] {
  const stored = STORED_MATCH_ALTERNATIVES_SCHEMA.safeParse(raw)
  if (!stored.success) return []

  return stored.data.map((entry) => ({
    value: entry.sku,
    label: entry.name,
    detail: entry.reason,
    score: entry.score,
  }))
}

/** The customers resolution scored highest, read back from its own evidence. */
async function customerAlternatives(
  env: Env,
  runId: string
): Promise<ReviewAlternative[]> {
  const row = await env.DB.prepare(
    `SELECT payload FROM run_step_evidence
      WHERE run_id = ? AND step_key = ? AND kind = ?`
  )
    .bind(runId, RESOLVE_CUSTOMER_STEP_KEY, CUSTOMER_EVIDENCE_KIND)
    .first<{ payload: string }>()

  if (!row) return []

  // A payload that step's own projection cannot read is reported there, once.
  // Here it costs the customer question its scored suggestions and no more.
  const stored = STORED_CUSTOMER_EVIDENCE_SCHEMA.safeParse(row.payload)
  if (!stored.success) return []

  return stored.data.candidates.map((candidate) => ({
    value: candidate.customerId,
    label: candidate.name,
    detail: "Scored by customer resolution, below the threshold.",
    score: candidate.score,
  }))
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
  "Only the owner can change this review. The run URL gives read access only."

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
    reasons: storedReasons(row.reasons),
    alternatives: storedAlternatives(row.alternatives),
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

/**
 * The two stored lists an item carries. Both are enrichment around a question
 * that is asked either way, so a column this build cannot read costs the item
 * its reasons or its offers and never the item itself.
 */
function storedReasons(raw: string): string[] {
  const stored = STORED_REASONS_SCHEMA.safeParse(raw)
  return stored.success ? stored.data : []
}

function storedAlternatives(raw: string): ReviewAlternative[] {
  const stored = STORED_REVIEW_ALTERNATIVES_SCHEMA.safeParse(raw)
  return stored.success ? stored.data : []
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
  const state = REVIEW_STATE_SCHEMA.catch("not_required").parse(review.state)

  if (state !== "pending") return state
  return Date.parse(review.expires_at) <= Date.now() ? "expired" : "pending"
}

/* -------------------------------------------------------------------------- */
/* The outcome, as a value                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One settled correction, carrying the values its owning step needs and
 * nothing else. Review resolves identifiers; it does not know the columns any
 * other step keeps them in.
 */
export type ResolvedDecision =
  | { kind: "customer"; customerId: string }
  | { kind: "quantity"; position: number; quantity: number }
  | { kind: "field"; position: number }
  | {
      kind: "product"
      position: number
      sku: string
      decision: "accepted_proposal" | "chose_alternative" | "chose_catalog"
      /** The wording the owner corrected, for the workspace alias. */
      sourcePhrase: string
      /**
       * When the alias this correction teaches must be deleted, derived from
       * the run's own retention. `null` means no alias can be recorded at all.
       * A deadline already in the past is still returned as it stands: whether
       * a stale alias is worth writing is the alias owner's rule, not a fact
       * about the review, and deciding it here would make this read depend on
       * the clock.
       */
      aliasExpiresAt: string | null
    }

/**
 * What the owner decided, once, as a value that crosses the seam out of this
 * module. The workflow applies it by handing each decision to the step that
 * owns the facts it corrects.
 */
export type ReviewOutcome = {
  state: "approved" | "rejected" | "expired"
  decidedAt: string
  /**
   * Empty unless the review was approved: a rejected or expired review ends
   * the run where it stands, so its half-made corrections are never applied.
   */
  decisions: ResolvedDecision[]
}

/**
 * Reads the settled review. Returns `null` while the decision is still the
 * owner's to make — no review at all, or a row still `pending` — so a caller
 * has nothing to apply until a transition has actually been persisted.
 *
 * A pure read: it writes nothing, including the expiry a closed window implies.
 * `expireReview` remains the one place that transition is recorded.
 */
export async function loadReviewOutcome(
  env: Env,
  runId: string
): Promise<ReviewOutcome | null> {
  const review = await loadReviewRow(env, runId)

  if (!review || !review.decided_at) return null
  if (
    review.state !== "approved" &&
    review.state !== "rejected" &&
    review.state !== "expired"
  ) {
    return null
  }

  const outcome: ReviewOutcome = {
    state: review.state,
    decidedAt: review.decided_at,
    decisions: [],
  }

  if (review.state !== "approved") return outcome

  const [items, run] = await Promise.all([
    loadSettlementItems(env, runId),
    env.DB.prepare(`SELECT source_kind, created_at FROM runs WHERE id = ?`)
      .bind(runId)
      .first<{ source_kind: string; created_at: string }>(),
  ])

  const aliasExpiresAt = run
    ? retentionDeadline(run.source_kind, run.created_at)
    : null

  outcome.decisions = items.flatMap((item) =>
    resolvedDecisionOf(item, aliasExpiresAt)
  )

  return outcome
}

/**
 * An item becomes a decision only when it is resolved and carries the value
 * its kind needs. Anything else is silently dropped rather than handed on: an
 * item without its value has nothing for an owning step to apply.
 */
function resolvedDecisionOf(
  item: ItemRow,
  aliasExpiresAt: string | null
): ResolvedDecision[] {
  if (item.state !== "resolved") return []

  const kind = REVIEW_ITEM_KIND_SCHEMA.safeParse(item.kind)
  if (!kind.success) return []

  switch (kind.data) {
    case "customer":
      return item.resolved_customer_id
        ? [{ kind: "customer", customerId: item.resolved_customer_id }]
        : []

    case "quantity":
      return item.resolved_quantity !== null
        ? [
            {
              kind: "quantity",
              position: item.position,
              quantity: item.resolved_quantity,
            },
          ]
        : []

    case "field":
      return [{ kind: "field", position: item.position }]

    case "product":
      return item.resolved_sku
        ? [
            {
              kind: "product",
              position: item.position,
              sku: item.resolved_sku,
              decision: PRODUCT_DECISION_SCHEMA.parse(item.decision),
              sourcePhrase: item.source_phrase,
              aliasExpiresAt,
            },
          ]
        : []
  }
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                   */
/* -------------------------------------------------------------------------- */

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

/** The checked form of one submitted decision, before it is recorded. */
type DecisionResolution =
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
): Promise<DecisionResolution> {
  const alternatives = storedAlternatives(row.alternatives)

  if (row.kind === "customer") {
    if (decision.action !== "customer" && decision.action !== "alternative") {
      return {
        state: "invalid",
        message: "The customer decision needs an existing customer",
      }
    }

    const customerId = decision.customerId?.trim() ?? ""

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

    // An omitted quantity fails the same range check a stated one does, and
    // says the same thing back.
    const quantity = decision.quantity ?? Number.NaN

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
      : (decision.sku?.trim().toUpperCase() ?? "")

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

export type ReviewDecision = z.infer<
  typeof REVIEW_SETTLEMENT_BODY_SCHEMA
>["action"]

export type ReviewSettlement =
  | { state: "settled"; decision: ReviewDecision; review: ReviewProjection }
  | { state: "incomplete"; review: ReviewProjection; message: string }
  | { state: "closed"; review: ReviewProjection; message: string }
  | { state: "absent" }

/**
 * The single transition out of `pending`.
 *
 * It records *what the owner decided*, and nothing about what that decision
 * means elsewhere. The claim is the race arbiter: whoever changes the row owns
 * the outcome, and the workflow — released by the caller, or woken by its own
 * deadline — reads that outcome back and hands each correction to the step
 * that owns the facts it corrects.
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
    if (review.state === "pending") {
      await expireReview(env, runId)
    }

    return {
      state: "closed",
      review: await loadReviewEvidence(env, runId),
      message: closedMessage(state),
    }
  }

  const items = await loadSettlementItems(env, runId)

  const unresolved = items.filter((item) => item.state !== "resolved")

  if (decision === "approve" && unresolved.length > 0) {
    return {
      state: "incomplete",
      review: await loadReviewEvidence(env, runId),
      message: `Confirm all items before you approve the review. Open items: ${unresolved.length}.`,
    }
  }

  const now = new Date().toISOString()

  const claimed = await commitSettlement(env, runId, decision, items, now)

  if (claimed !== 1) {
    const currentRow = await loadReviewRow(env, runId)

    // The SQL transition checks the database clock, not the earlier read. If
    // the window crossed its deadline between those two operations, persist
    // the expiry now and return that stable outcome.
    if (
      currentRow?.state === "pending" &&
      effectiveState(currentRow) === "expired"
    ) {
      await expireReview(env, runId)
    }

    const current = await loadReviewEvidence(env, runId)

    return {
      state: "closed",
      review: current,
      message: closedMessage(current.state),
    }
  }

  console.log(
    JSON.stringify({
      event: decision === "approve" ? "review_approved" : "review_rejected",
      runId,
      step: REVIEW_STEP_KEY,
      items: items.length,
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
      return "This review is already approved"
    case "rejected":
      return "This review is already rejected"
    case "expired":
      return "This review window has closed"
    default:
      return "This run has nothing waiting for review"
  }
}

async function loadSettlementItems(
  env: Env,
  runId: string
): Promise<ItemRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, kind, position, source_phrase, detail, proposed_label,
            proposed_sku, proposed_quantity, proposed_customer_id,
            confidence_label, confidence_score, heuristic, reasons,
            alternatives, state, decision, resolved_sku, resolved_quantity,
            resolved_customer_id, resolved_at
       FROM run_review_items WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(runId)
    .all<ItemRow>()

  return rows.results
}

/**
 * Claims the transition out of `pending`. One guarded statement, and its
 * result is the arbiter: exactly one caller can see a change here, whatever
 * else is happening at the same moment.
 *
 * Nothing else is written. What an approval means for the run's own facts —
 * the quantity a line is priced with, the article it is matched to, the
 * customer it resolved to — belongs to the steps that own those facts, and the
 * workflow applies it to them once this claim has decided who won.
 */
async function commitSettlement(
  env: Env,
  runId: string,
  decision: ReviewDecision,
  items: ItemRow[],
  now: string
): Promise<number> {
  const approvalGuard =
    decision === "approve"
      ? `AND item_count > 0
         AND item_count =
             (SELECT COUNT(*) FROM run_review_items WHERE run_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM run_review_items
            WHERE run_id = ? AND state <> 'resolved'
         )`
      : ""

  const claim = env.DB.prepare(
    `UPDATE run_reviews
        SET state = ?, decided_at = ?, summary = ?
      WHERE run_id = ? AND state = 'pending'
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ${approvalGuard}`
  ).bind(
    decision === "approve" ? "approved" : "rejected",
    now,
    decision === "approve"
      ? `The owner approved ${items.length} ${plural(items.length, "item", "items")}.`
      : "The owner rejected the review. The run stops here.",
    runId,
    ...(decision === "approve" ? [runId, runId] : [])
  )

  return (await claim.run()).meta.changes
}

/**
 * The window closed with nothing decided. A terminal outcome, not a retry.
 *
 * Only the review's own row moves here. The run step and the run's state are
 * the workflow's to record, from the outcome this writes down, so that an
 * expiry ends the run through exactly the same path an approval or a rejection
 * does — and is recorded exactly once, whoever noticed the deadline first.
 */
export async function expireReview(env: Env, runId: string): Promise<boolean> {
  const now = new Date().toISOString()

  const claimed = await env.DB.prepare(
    `UPDATE run_reviews
        SET state = 'expired', decided_at = ?,
            summary = 'The review time expired.'
      WHERE run_id = ? AND state = 'pending'`
  )
    .bind(now, runId)
    .run()

  if (claimed.meta.changes !== 1) return false

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
