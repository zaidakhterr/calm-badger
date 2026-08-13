/**
 * Turning model text into RFQ facts the rest of the workflow may trust.
 *
 * Three gates sit between a provider response and anything canonical:
 *
 * 1. one JSON-repair attempt, and only one, over the raw text;
 * 2. the Zod schema below, which is also the schema the provider is asked to
 *    constrain its response to; and
 * 3. business validation against the seeded catalogue.
 *
 * Failing the first two gates is terminal: the run stops with an honest error
 * rather than continuing on guesswork. Failing the third is not — a quantity
 * that is not a usable number, or a catalogue reference the model invented,
 * marks that one line for human review and is discarded, so an invented fact
 * can never reach pricing.
 */

import { z } from "zod"

/** The instruction sent to the model. Static copy: no run data, no expected answers. */
export const RFQ_EXTRACTION_INSTRUCTION = [
  "You extract request-for-quotation facts from the text of a business email and its attachments.",
  "Use only the supplied document text. Never invent a company, contact, article number, quantity, or date that the documents do not state.",
  "When a fact is absent, return null rather than a guess.",
  "Quantities are whole numbers of units. Keep each product reference exactly as the request writes it, including misspellings and superseded numbers.",
  "Set catalogSku only when the document literally prints a supplier article number in the form XX-XXX-0000.",
  "Record for every line which source document and page it came from.",
].join(" ")

export const RFQ_SCHEMA_NAME = "rfq_extraction"

export const RFQ_SCHEMA_DESCRIPTION =
  "Customer, source, deadline, and requested line items read from one request for quotation."

const nullableText = (max: number) => z.string().max(max).nullable()

export const rfqExtractionSchema = z.object({
  customer: z.object({
    companyName: nullableText(200),
    contactName: nullableText(160),
    contactEmail: nullableText(200),
    contactPhone: nullableText(60),
    deliveryLocation: nullableText(200),
  }),
  source: z.object({
    channel: z.enum(["email", "pdf", "image", "mixed"]),
    subject: nullableText(300),
    receivedAt: nullableText(60),
    references: z.array(z.string().max(200)).max(20),
  }),
  deadline: z.object({
    date: nullableText(40),
    text: nullableText(120),
  }),
  lineItems: z
    .array(
      z.object({
        position: z.number().int().min(1).max(999),
        reference: z.string().min(1).max(200),
        description: z.string().max(400),
        quantity: z.number().nullable(),
        unit: nullableText(40),
        catalogSku: nullableText(40),
        sourceLabel: z.string().max(200),
        sourcePage: z.number().int().nullable(),
      })
    )
    .max(60),
})

export type RfqExtraction = z.infer<typeof rfqExtractionSchema>

/* -------------------------------------------------------------------------- */
/* Gate 1: parse, with at most one repair attempt                             */
/* -------------------------------------------------------------------------- */

export type ParseOutcome =
  | { state: "parsed"; value: unknown; repaired: boolean }
  | { state: "irreparable"; reason: string }

/**
 * Parses model text. If the text is not JSON, exactly one repair attempt is
 * made — the common damage is a prose preamble, a fenced code block, or a
 * trailing comma — and its result is final either way. There is no second
 * attempt and no second provider call.
 */
export function parseModelOutput(text: string): ParseOutcome {
  const direct = tryParse(text)
  if (direct.ok)
    return { state: "parsed", value: direct.value, repaired: false }

  const repaired = repairJson(text)

  if (repaired !== null) {
    const second = tryParse(repaired)
    if (second.ok) {
      return { state: "parsed", value: second.value, repaired: true }
    }
  }

  return {
    state: "irreparable",
    reason: "The model returned output that is not valid JSON.",
  }
}

/** The single repair attempt. Deterministic and local: it costs nothing. */
export function repairJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text

  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start === -1 || end <= start) return null

  const candidate = body
    .slice(start, end + 1)
    // Trailing commas before a closing brace or bracket.
    .replace(/,(\s*[}\]])/g, "$1")

  return candidate === text ? null : candidate
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false }

  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch {
    return { ok: false }
  }
}

/* -------------------------------------------------------------------------- */
/* Gate 2: the schema                                                         */
/* -------------------------------------------------------------------------- */

export type SchemaOutcome =
  | { state: "valid"; rfq: RfqExtraction }
  | { state: "invalid"; issues: string[] }

export function validateAgainstSchema(value: unknown): SchemaOutcome {
  const result = rfqExtractionSchema.safeParse(value)

  if (result.success) return { state: "valid", rfq: result.data }

  return {
    state: "invalid",
    // Path and rule only. Never the offending value, which is model text.
    issues: result.error.issues
      .slice(0, 12)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`),
  }
}

/* -------------------------------------------------------------------------- */
/* Gate 3: business validation                                                */
/* -------------------------------------------------------------------------- */

export const MAX_LINE_QUANTITY = 100_000

export type ValidatedLineItem = {
  position: number
  reference: string
  description: string
  /** Null whenever the extracted quantity was not usable. */
  quantity: number | null
  unit: string | null
  /** Only ever a SKU that exists in the catalogue. */
  catalogSku: string | null
  sourceLabel: string
  sourcePage: number | null
  state: "accepted" | "review_required"
  reason: string | null
}

export type ValidatedRfq = {
  customer: RfqExtraction["customer"]
  source: RfqExtraction["source"]
  deadline: RfqExtraction["deadline"]
  lineItems: ValidatedLineItem[]
}

/**
 * Applies the business rules that the schema cannot express: a quantity has to
 * be a usable whole number, and a catalogue reference has to exist. Neither
 * failure stops the run; both strip the offending fact and mark the line for
 * human review, so later steps only ever see facts that survived.
 */
export function applyBusinessRules(
  rfq: RfqExtraction,
  knownSkus: ReadonlySet<string>
): ValidatedRfq {
  const seen = new Set<number>()

  const lineItems = rfq.lineItems.map((line, index): ValidatedLineItem => {
    const reasons: string[] = []

    let position = line.position
    while (seen.has(position)) position += 1
    seen.add(position)

    let quantity: number | null = line.quantity
    if (
      quantity === null ||
      !Number.isFinite(quantity) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_LINE_QUANTITY
    ) {
      reasons.push(
        quantity === null
          ? "No quantity was stated for this line."
          : "The extracted quantity is not a usable whole number."
      )
      quantity = null
    }

    let catalogSku: string | null = line.catalogSku
      ? line.catalogSku.trim().toUpperCase()
      : null

    if (catalogSku !== null && !knownSkus.has(catalogSku)) {
      reasons.push(
        "The extracted article number does not exist in the catalogue."
      )
      catalogSku = null
    }

    const reference = line.reference.trim()

    if (reference.length === 0) {
      reasons.push("The line has no product reference.")
    }

    return {
      position,
      reference: reference || `Line ${index + 1}`,
      description: line.description.trim(),
      quantity,
      unit: line.unit?.trim() || null,
      catalogSku,
      sourceLabel: line.sourceLabel,
      sourcePage: line.sourcePage,
      state: reasons.length === 0 ? "accepted" : "review_required",
      reason: reasons.length === 0 ? null : reasons.join(" "),
    }
  })

  lineItems.sort((left, right) => left.position - right.position)

  return {
    customer: rfq.customer,
    source: rfq.source,
    deadline: rfq.deadline,
    lineItems,
  }
}

/* -------------------------------------------------------------------------- */
/* Confidence                                                                 */
/* -------------------------------------------------------------------------- */

export type ConfidenceLabel = "High" | "Medium" | "Review"

export type Confidence = {
  label: ConfidenceLabel
  score: number
  /** The deductions, in words, so the number is never mistaken for certainty. */
  heuristic: string
}

/**
 * A demo heuristic, not a calibrated probability. It starts from one and
 * deducts for the things a reviewer would actually worry about.
 */
export function scoreExtraction(
  validated: ValidatedRfq,
  repaired: boolean
): Confidence {
  const deductions: { reason: string; amount: number }[] = []
  const total = validated.lineItems.length
  const flagged = validated.lineItems.filter(
    (line) => line.state === "review_required"
  ).length

  if (repaired) {
    deductions.push({ reason: "the model output needed repair", amount: 0.15 })
  }

  if (total === 0) {
    deductions.push({ reason: "no line items were found", amount: 0.4 })
  } else if (flagged > 0) {
    deductions.push({
      reason: `${flagged} of ${total} lines failed a business rule`,
      amount: Math.min(0.5, (0.5 * flagged) / total),
    })
  }

  if (!validated.customer.contactEmail) {
    deductions.push({ reason: "no contact address was found", amount: 0.1 })
  }

  if (!validated.deadline.date && !validated.deadline.text) {
    deductions.push({ reason: "no deadline was stated", amount: 0.1 })
  }

  return summarise(deductions, "Extraction confidence")
}

export function summarise(
  deductions: { reason: string; amount: number }[],
  subject: string
): Confidence {
  const score = clamp(
    1 - deductions.reduce((total, entry) => total + entry.amount, 0)
  )

  const heuristic =
    deductions.length === 0
      ? `${subject} starts at 1.00 and nothing was deducted.`
      : `${subject} starts at 1.00, less ${deductions
          .map((entry) => `${entry.amount.toFixed(2)} because ${entry.reason}`)
          .join(", and ")}.`

  return { label: labelFor(score), score, heuristic }
}

export function labelFor(score: number): ConfidenceLabel {
  if (score >= 0.8) return "High"
  if (score >= 0.55) return "Medium"
  return "Review"
}

function clamp(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
}
