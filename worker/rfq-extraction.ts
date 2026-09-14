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

/**
 * Document references the request quoted at itself — an order number, a
 * previous quote. Named because they outlive the extraction: the RFQ row
 * stores them and the canonical quote carries them on.
 */
export const SOURCE_REFERENCES_SCHEMA = z.array(z.string().max(200)).max(20)

/**
 * The three parts of an extraction that survive business validation untouched.
 * They are named separately because `structure-rfq.ts` stores exactly these
 * beside the lines it rewrote, and the stored RFQ must be the same contract
 * rather than a second description of it.
 */
export const RFQ_CUSTOMER_SCHEMA = z.object({
  companyName: nullableText(200),
  contactName: nullableText(160),
  contactEmail: nullableText(200),
  contactPhone: nullableText(60),
  deliveryLocation: nullableText(200),
})

export const RFQ_SOURCE_SCHEMA = z.object({
  channel: z.enum(["email", "pdf", "image", "mixed"]),
  subject: nullableText(300),
  receivedAt: nullableText(60),
  references: SOURCE_REFERENCES_SCHEMA,
})

export const RFQ_DEADLINE_SCHEMA = z.object({
  date: nullableText(40),
  text: nullableText(120),
})

export const rfqExtractionSchema = z.object({
  customer: RFQ_CUSTOMER_SCHEMA,
  source: RFQ_SOURCE_SCHEMA,
  deadline: RFQ_DEADLINE_SCHEMA,
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

/** Fields read by storage and business validation. Prompt policy lives in its full schema. */
export const RFQ_EXTRACTION_CONTRACT = z.object({
  customer: z.object({
    companyName: z.string().nullable(),
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    deliveryLocation: z.string().nullable(),
  }),
  source: z.object({
    channel: z.enum(["email", "pdf", "image", "mixed"]),
    subject: z.string().nullable(),
    receivedAt: z.string().nullable(),
    references: z.array(z.string()),
  }),
  deadline: z.object({
    date: z.string().nullable(),
    text: z.string().nullable(),
  }),
  lineItems: z.array(
    z.object({
      position: z.number().int(),
      reference: z.string(),
      description: z.string(),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      catalogSku: z.string().nullable(),
      sourceLabel: z.string(),
      sourcePage: z.number().int().nullable(),
    })
  ),
})

export type RfqExtraction = z.infer<typeof RFQ_EXTRACTION_CONTRACT>

/* -------------------------------------------------------------------------- */
/* Gate 1: parse, with at most one repair attempt                             */
/* -------------------------------------------------------------------------- */

export type ParseOutcome =
  /** JSON text, not yet an RFQ: gate two decides whether it says anything. */
  | { state: "parsed"; json: string; repaired: boolean }
  | { state: "irreparable"; reason: string }

/**
 * Parses model text. If the text is not JSON, exactly one repair attempt is
 * made — the common damage is a prose preamble, a fenced code block, or a
 * trailing comma — and its result is final either way. There is no second
 * attempt and no second provider call.
 *
 * What comes back is the JSON text that parsed, not a decoded value: the only
 * thing worth handing on is something a schema has agreed to, and that is the
 * next gate's answer to give.
 */
export function parseModelOutput(text: string): ParseOutcome {
  const direct = text.trim()
  if (isJson(direct)) return { state: "parsed", json: direct, repaired: false }

  const repaired = repairJson(text)

  if (repaired !== null && isJson(repaired)) {
    return { state: "parsed", json: repaired, repaired: true }
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

function isJson(text: string): boolean {
  if (text.trim().length === 0) return false

  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * JSON text, decoded. Shared by both model-output gates so "not JSON" and "not
 * the contract" stay one parse with two named failures.
 */
export const JSON_TEXT_SCHEMA = z.string().transform((raw, ctx) => {
  try {
    const decoded: unknown = JSON.parse(raw)
    return decoded
  } catch {
    ctx.addIssue({ code: "custom", message: "The text is not JSON." })
    return z.NEVER
  }
})

/* -------------------------------------------------------------------------- */
/* Gate 2: the schema                                                         */
/* -------------------------------------------------------------------------- */

export type SchemaOutcome =
  | { state: "valid"; rfq: RfqExtraction }
  | { state: "invalid"; issues: string[] }

/** The extraction contract over the JSON text gate one accepted. */
export function validateAgainstSchema(
  json: string,
  schema: z.ZodType = rfqExtractionSchema
): SchemaOutcome {
  const result = JSON_TEXT_SCHEMA.pipe(schema)
    .pipe(RFQ_EXTRACTION_CONTRACT)
    .safeParse(json)

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

/**
 * A demo score and the words that explain it.
 *
 * Every step that judges something records one of these, and three of them are
 * persisted inside step evidence, so the schema is the contract those readers
 * parse with rather than a shape each of them guesses at.
 */
export const CONFIDENCE_SCHEMA = z.object({
  label: z.enum(["High", "Medium", "Review"]),
  score: z.number(),
  /** The deductions, in words, so the number is never mistaken for certainty. */
  heuristic: z.string(),
})

export type Confidence = z.infer<typeof CONFIDENCE_SCHEMA>

export type ConfidenceLabel = Confidence["label"]

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
