/**
 * Deterministic contract fake for structured extraction.
 *
 * It exists so tests and fixture evaluation can exercise the real workflow
 * without provider credentials, network access, or cost. It implements the same
 * `ExtractionProvider` contract as the live client and behaves like a plausible
 * extractor: it reads the document text it was given — which in tests is the
 * output of the contract fake OCR reader — and writes a JSON string, exactly as
 * a model would. It has no access to the curated scenarios and no knowledge of
 * any expected answer, so every repair, schema, and business-validation path
 * downstream is genuinely exercised rather than short-circuited.
 * `selectExtractionProvider` refuses to build it when `APP_ENV` is production.
 *
 * Test hooks: a request whose document text contains one of the `trigger-…`
 * markers below produces the corresponding failure, which is how the provider,
 * repair, schema, and business-validation contracts are exercised.
 */

import {
  ExtractionProviderError,
  type ExtractionDocument,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResult,
} from "./extraction"

const PROVIDER = "contract-fake"

const TRIGGERS = {
  providerError: "trigger-extraction-error",
  unparsable: "trigger-unparsable-output",
  repairable: "trigger-repairable-output",
  schemaViolation: "trigger-schema-violation",
  invalidQuantity: "trigger-invalid-quantity",
  inventedSku: "trigger-invented-sku",
} as const

/** Words that carry no signal when two descriptions are compared. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "of",
  "our",
  "the",
  "to",
  "with",
])

const SKU_PATTERN = /\b([A-Z]{2}-[A-Z]{3}-\d{4})\b/

const EMAIL_HEADER_PATTERN =
  /^(from|to|cc|company|subject|received|forwarded (from|date|subject)):/i

type DraftLine = {
  position: number
  reference: string
  description: string
  quantity: number | null
  unit: string | null
  catalogSku: string | null
  sourceLabel: string
  sourcePage: number
}

export function createContractFakeExtractionProvider(
  env: Env
): ExtractionProvider {
  const model = `${env.OPENROUTER_EXTRACTION_MODEL}-contract-fake`

  return {
    name: PROVIDER,
    model,

    extract(request: ExtractionRequest): Promise<ExtractionResult> {
      const startedAt = Date.now()
      const corpus = request.documents
        .map((document) => document.markdown)
        .join("\n")
        .toLowerCase()

      if (corpus.includes(TRIGGERS.providerError)) {
        throw new ExtractionProviderError(
          PROVIDER,
          "The extraction model rejected the request (503).",
          503
        )
      }

      const payload = buildPayload(request.documents, corpus)
      const text = renderText(payload, corpus)

      return Promise.resolve({
        model,
        text,
        usage: usageFor(request.documents, text),
        latencyMs: Math.max(1, Date.now() - startedAt),
        finishReason: "stop",
        reportedCostUsd: null,
      })
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the documents                                                      */
/* -------------------------------------------------------------------------- */

function buildPayload(
  documents: ExtractionDocument[],
  corpus: string
): Record<string, unknown> {
  const emailText = documents
    .filter((document) => document.kind === "email_body")
    .map((document) => document.markdown)
    .join("\n")

  const lines = readLineItems(documents, emailText)

  if (corpus.includes(TRIGGERS.invalidQuantity) && lines.length > 0) {
    lines[0].quantity = -3
  }

  if (corpus.includes(TRIGGERS.inventedSku) && lines.length > 0) {
    lines[0].catalogSku = "NX-ZZZ-9999"
  }

  return {
    customer: readCustomer(emailText, documents),
    source: readSource(emailText, documents),
    deadline: readDeadline(emailText),
    lineItems: lines,
  }
}

function readCustomer(
  emailText: string,
  documents: ExtractionDocument[]
): Record<string, unknown> {
  const sender = /^From:\s*(.+?)\s*<([^>]+)>\s*$/im.exec(emailText)
  const bareSender = /^From:\s*([^\s<>@]+@[^\s<>]+)\s*$/im.exec(emailText)
  const company = /^Company:\s*(.+)$/im.exec(emailText)
  const phone = /^\s*(\+\d[\d\s]{6,})$/m.exec(emailText)

  return {
    companyName: company ? company[1].trim() : null,
    contactName: sender ? sender[1].trim() : null,
    contactEmail: sender
      ? sender[2].trim().toLowerCase()
      : bareSender
        ? bareSender[1].trim().toLowerCase()
        : null,
    contactPhone: phone ? phone[1].trim() : null,
    deliveryLocation: readDeliveryLocation(emailText, documents),
  }
}

function readDeliveryLocation(
  emailText: string,
  documents: ExtractionDocument[]
): string | null {
  for (const document of documents) {
    const stated = /^\s*DELIVERY:\s*(.+)$/im.exec(document.markdown)
    if (stated) return titleCase(stated[1].trim())
  }

  const mentioned =
    /\bfor the ([A-Za-z][\w'-]*(?: [\w'-]+){0,3} (?:depot|workshop|site|warehouse|plant|store|office))\b/i.exec(
      emailText
    )

  return mentioned ? mentioned[1].trim() : null
}

function readSource(
  emailText: string,
  documents: ExtractionDocument[]
): Record<string, unknown> {
  const subject = /^Subject:\s*(.+)$/im.exec(emailText)
  const received = /^Received:\s*(.+)$/im.exec(emailText)
  const kinds = new Set(documents.map((document) => document.kind))

  const channel =
    kinds.size > 1
      ? "mixed"
      : kinds.has("attachment")
        ? "pdf"
        : kinds.has("inline_image")
          ? "image"
          : "email"

  return {
    channel,
    subject: subject ? subject[1].trim() : null,
    receivedAt: received ? received[1].trim() : null,
    references: [
      ...new Set(
        documents
          .filter((document) => document.kind !== "email_body")
          .map((document) => document.label)
      ),
    ].slice(0, 20),
  }
}

function readDeadline(emailText: string): Record<string, unknown> {
  const isoDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(stripHeaders(emailText))
  const relative = /\b((?:next|this) week|by \d{1,2}\s+[A-Za-z]+)\b/i.exec(
    emailText
  )

  return {
    date: isoDate ? isoDate[1] : null,
    text: relative ? relative[1] : isoDate ? isoDate[1] : null,
  }
}

/**
 * Line items come from the numbered lists the documents print, with quantities
 * borrowed from the email prose whenever a list omits them — which is how a
 * forwarded request that keeps its amounts in the covering note actually reads.
 */
function readLineItems(
  documents: ExtractionDocument[],
  emailText: string
): DraftLine[] {
  const listed = readNumberedLines(documents)
  const quantified = readQuantityPhrases(emailText)

  if (listed.length === 0) {
    return quantified.map((phrase, index) => ({
      position: index + 1,
      reference: phrase.description,
      description: phrase.description,
      quantity: phrase.quantity,
      unit: null,
      catalogSku: readSku(phrase.description),
      sourceLabel: emailLabel(documents),
      sourcePage: 1,
    }))
  }

  const taken = new Set<number>()

  for (const line of listed) {
    if (line.quantity !== null) continue

    let bestIndex = -1
    let bestOverlap = 1

    for (const [index, phrase] of quantified.entries()) {
      if (taken.has(index)) continue

      const overlap = tokenOverlap(line.description, phrase.description)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestIndex = index
      }
    }

    if (bestIndex >= 0) {
      taken.add(bestIndex)
      line.quantity = quantified[bestIndex].quantity
    }
  }

  return listed
}

function readNumberedLines(documents: ExtractionDocument[]): DraftLine[] {
  const lines: DraftLine[] = []

  for (const document of documents) {
    for (const raw of document.markdown.split("\n")) {
      const numbered = /^\s*(\d{1,3})\s{2,}(\S.*?)\s*$/.exec(raw)
      if (!numbered) continue

      let rest = numbered[2]
      let quantity: number | null = null
      let unit: string | null = null

      const withUnit = /^(.*?)\s{2,}(\d{1,6})\s+([A-Za-z]+)$/.exec(rest)
      const withoutUnit = /^(.*?)\s{2,}(\d{1,6})$/.exec(rest)

      if (withUnit) {
        rest = withUnit[1]
        quantity = Number.parseInt(withUnit[2], 10)
        unit = withUnit[3].toLowerCase()
      } else if (withoutUnit) {
        rest = withoutUnit[1]
        quantity = Number.parseInt(withoutUnit[2], 10)
      }

      const article = /^([A-Z]{2}-[A-Z]{3}-\d{4})\s{2,}(\S.*)$/.exec(rest)
      const description = (article ? article[2] : rest).trim()

      if (description.length === 0) continue

      lines.push({
        position: Number.parseInt(numbered[1], 10),
        reference: article ? article[1] : description,
        description,
        quantity,
        unit,
        catalogSku: article ? article[1] : readSku(description),
        sourceLabel: document.label,
        sourcePage: document.pageNumber,
      })
    }
  }

  return lines
}

/** "…we need: 16 pleeted panel filter, 12 grease cartridges and 4 belts". */
function readQuantityPhrases(
  emailText: string
): { quantity: number; description: string }[] {
  const phrases: { quantity: number; description: string }[] = []

  for (const segment of stripHeaders(emailText).split(/[,.;:\n]|\s+and\s+/i)) {
    const match = /(\d{1,5})\s+([A-Za-z]\S*(?:\s+\S+)*)/.exec(segment.trim())
    if (!match) continue

    const description = match[2].trim()
    if (description.length < 3) continue

    phrases.push({
      quantity: Number.parseInt(match[1], 10),
      description,
    })
  }

  return phrases
}

function stripHeaders(emailText: string): string {
  return emailText
    .split("\n")
    .filter((line) => !EMAIL_HEADER_PATTERN.test(line.trim()))
    .join("\n")
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = tokenise(left)
  const rightTokens = new Set(tokenise(right))

  return [...new Set(leftTokens)].filter((token) => rightTokens.has(token))
    .length
}

function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

function readSku(value: string): string | null {
  const match = SKU_PATTERN.exec(value.toUpperCase())
  return match ? match[1] : null
}

function emailLabel(documents: ExtractionDocument[]): string {
  const email = documents.find((document) => document.kind === "email_body")
  return email ? email.label : "Email body"
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
}

/* -------------------------------------------------------------------------- */
/* Rendering model text                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A model returns text, not an object, and not always clean text. The markers
 * reproduce the three shapes the workflow has to survive: valid JSON, JSON that
 * one repair attempt can rescue, and output that nothing can rescue.
 */
function renderText(payload: Record<string, unknown>, corpus: string): string {
  if (corpus.includes(TRIGGERS.unparsable)) {
    return "I could not read the attached documents well enough to answer."
  }

  if (corpus.includes(TRIGGERS.schemaViolation)) {
    return JSON.stringify({ ...payload, lineItems: "none found" })
  }

  const json = JSON.stringify(payload, null, 2)

  if (corpus.includes(TRIGGERS.repairable)) {
    // A preamble, a fenced block, and a trailing comma: the usual damage.
    return `Here is the structured request:\n\n\`\`\`json\n${json.replace(
      /\n\}$/,
      ",\n}"
    )}\n\`\`\`\n`
  }

  return json
}

/** A stable, content-derived token count so usage evidence stays reproducible. */
function usageFor(documents: ExtractionDocument[], text: string) {
  const promptChars = documents.reduce(
    (total, document) => total + document.markdown.length,
    0
  )
  const inputTokens = Math.ceil(promptChars / 4)
  const outputTokens = Math.ceil(text.length / 4)

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  }
}
