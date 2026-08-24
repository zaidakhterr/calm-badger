/**
 * The canonical quote.
 *
 * One provider-neutral artifact stands between pricing and delivery. Adapters
 * transform this and nothing else, the interface renders this, and the JSON a
 * reviewer downloads *is* this — so the same document is what left the system,
 * whatever an adapter later made of it.
 *
 * It is assembled by an explicit allowlist, exactly like the evidence
 * projections: it carries the resolved customer and location, the documents the
 * request arrived as, the selected products with their quantities, prices, and
 * applied rules, the tax and totals, and adapter-independent metadata. It never
 * carries a storage key, an owner capability, an API key, a prompt, or a raw
 * provider response, because those fields are simply never read into it.
 */

import { z } from "zod"

import {
  priceLine,
  PRICING_RULE_SCHEMA,
  quoteTotals,
  QUOTE_TOTALS_SCHEMA,
  ROUNDING_NOTE,
  type AppliedPrice,
} from "./pricing"
import { STORED_SOURCE_REFERENCES_SCHEMA } from "./structure-rfq"

/** Bumped when the shape changes; adapters and downloads state it. */
export const QUOTE_SCHEMA = "rfq-relay.canonical-quote/v1"

export const QUOTE_CUSTOMER_SCHEMA = z.object({
  customerId: z.string(),
  name: z.string(),
  tier: z.string(),
  tierDiscountBp: z.number(),
  contact: z
    .object({ name: z.string(), role: z.string(), email: z.string() })
    .nullable(),
  location: z
    .object({
      label: z.string(),
      street: z.string(),
      postalCode: z.string(),
      city: z.string(),
      country: z.string(),
    })
    .nullable(),
})

export type QuoteCustomer = z.infer<typeof QUOTE_CUSTOMER_SCHEMA>

export const QUOTE_SOURCE_DOCUMENT_SCHEMA = z.object({
  kind: z.string(),
  label: z.string(),
  mediaType: z.string(),
  pageCount: z.number(),
})

export type QuoteSourceDocument = z.infer<typeof QUOTE_SOURCE_DOCUMENT_SCHEMA>

export const QUOTE_SOURCE_SCHEMA = z.object({
  channel: z.string(),
  subject: z.string().nullable(),
  receivedAt: z.string().nullable(),
  /** Document references the request itself quoted, e.g. an order number. */
  references: z.array(z.string()),
  documents: z.array(QUOTE_SOURCE_DOCUMENT_SCHEMA),
})

export type QuoteSource = z.infer<typeof QUOTE_SOURCE_SCHEMA>

export const QUOTE_LINE_SCHEMA = z.object({
  position: z.number(),
  /** What the request asked for, in its own words. */
  requested: z.object({
    reference: z.string(),
    description: z.string(),
    sourceLabel: z.string(),
    sourcePage: z.number().nullable(),
  }),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  quantity: z.number(),
  pricing: z.object({
    rule: PRICING_RULE_SCHEMA,
    ruleLabel: z.string(),
    basePriceCents: z.number(),
    unitPriceCents: z.number(),
    discountBp: z.number().nullable(),
    explanation: z.string(),
  }),
  subtotalCents: z.number(),
  /** How the product was decided, so the price is traceable to a match. */
  match: z.object({ method: z.string(), confidenceLabel: z.string() }),
})

export type QuoteLine = z.infer<typeof QUOTE_LINE_SCHEMA>

/**
 * The document itself, as this module assembles it and as everything
 * downstream reads it back.
 *
 * Nothing here defaults. A quote is what a customer would be charged, so a
 * field this schema cannot read is not a quote with a gap in it: it is not
 * this document, and whoever asked for it is told there is none rather than
 * shown an amount nobody computed.
 */
export const CANONICAL_QUOTE_SCHEMA = z.object({
  schema: z.literal(QUOTE_SCHEMA),
  quoteNumber: z.string(),
  issuedAt: z.string(),
  currency: z.literal("EUR"),
  /** Line prices exclude VAT; the totals add it once. */
  priceBasis: z.literal("excluding_vat"),
  customer: QUOTE_CUSTOMER_SCHEMA,
  source: QUOTE_SOURCE_SCHEMA,
  lines: z.array(QUOTE_LINE_SCHEMA),
  totals: QUOTE_TOTALS_SCHEMA,
  metadata: z.object({
    generator: z.string(),
    schemaVersion: z.string(),
    pricingPrecedence: z.array(PRICING_RULE_SCHEMA),
    rounding: z.string(),
    note: z.string(),
  }),
})

export type CanonicalQuote = z.infer<typeof CANONICAL_QUOTE_SCHEMA>

/**
 * The quote as a stored column holds it: this document, JSON-encoded by
 * whichever step wrote it down. Readers parse the text with this rather than
 * trusting that what was stored is still what this build calls a quote.
 */
export const STORED_QUOTE_DOCUMENT_SCHEMA = z
  .string()
  .transform((raw, ctx) => {
    try {
      const decoded: unknown = JSON.parse(raw)
      return decoded
    } catch {
      ctx.addIssue({ code: "custom", message: "The column is not JSON text." })
      return z.NEVER
    }
  })
  .pipe(CANONICAL_QUOTE_SCHEMA)

const GENERATOR = "RFQ Relay"

const PRICING_PRECEDENCE: CanonicalQuote["metadata"]["pricingPrecedence"] = [
  "historical_override",
  "customer_tier",
  "quantity_break",
  "catalog_base",
]

const METADATA_NOTE =
  "This quote does not depend on a delivery provider. Catalogue and customer rules calculate all prices. A language model does not calculate prices."

export type QuoteAssembly =
  | { state: "ready"; quote: CanonicalQuote }
  | { state: "blocked"; reason: string }

type ResolutionRow = {
  state: string
  customer_id: string | null
  contact_id: string | null
  location_id: string | null
}

type LineRow = {
  position: number
  reference: string
  description: string
  quantity: number | null
  source_label: string
  source_page: number | null
  validation_state: string
  match_state: string | null
  sku: string | null
  method: string | null
  confidence_label: string | null
}

/**
 * Builds the quote for a run, or explains why the run may not be priced yet.
 *
 * A run is priceable only when identity is settled and every requested line has
 * an accepted product *and* a usable quantity. Anything else waits for the
 * owner review node rather than being priced on a guess.
 */
export async function assembleQuote(
  env: Env,
  runId: string
): Promise<QuoteAssembly> {
  const resolution = await env.DB.prepare(
    `SELECT state, customer_id, contact_id, location_id
       FROM run_customer_resolution WHERE run_id = ?`
  )
    .bind(runId)
    .first<ResolutionRow>()

  if (
    !resolution ||
    resolution.state !== "resolved" ||
    !resolution.customer_id
  ) {
    return {
      state: "blocked",
      reason:
        "The run does not have a confirmed customer. The system cannot apply customer price rules.",
    }
  }

  const lines = await env.DB.prepare(
    `SELECT l.position AS position, l.reference AS reference,
            l.description AS description, l.quantity AS quantity,
            l.source_label AS source_label, l.source_page AS source_page,
            l.validation_state AS validation_state,
            m.state AS match_state, m.sku AS sku, m.method AS method,
            m.confidence_label AS confidence_label
       FROM run_rfq_line_items l
       LEFT JOIN run_line_matches m
         ON m.run_id = l.run_id AND m.position = l.position
      WHERE l.run_id = ? ORDER BY l.position ASC`
  )
    .bind(runId)
    .all<LineRow>()

  if (lines.results.length === 0) {
    return {
      state: "blocked",
      reason: "The request contains no lines to price.",
    }
  }

  const unmatched = lines.results.filter(
    (line) => line.match_state !== "accepted" || !line.sku
  )

  if (unmatched.length > 0) {
    return {
      state: "blocked",
      reason: `${unmatched.length} of ${lines.results.length} lines do not have an accepted product match.`,
    }
  }

  const unusable = lines.results.filter(
    (line) =>
      line.validation_state !== "accepted" ||
      line.quantity === null ||
      line.quantity <= 0
  )

  if (unusable.length > 0) {
    return {
      state: "blocked",
      reason: `${unusable.length} of ${lines.results.length} lines do not have a confirmed quantity.`,
    }
  }

  const customer = await loadCustomer(env, resolution)

  if (!customer) {
    return {
      state: "blocked",
      reason: "The resolved customer is no longer in the catalogue.",
    }
  }

  const skus = [...new Set(lines.results.map((line) => line.sku!))]
  const [products, breaks, overrides] = await Promise.all([
    loadProducts(env, skus),
    loadQuantityBreaks(env, skus),
    loadActiveOverrides(env, customer.customerId, skus),
  ])

  const priced: QuoteLine[] = []

  for (const line of lines.results) {
    const product = products.get(line.sku!)

    if (!product) {
      return {
        state: "blocked",
        reason: `${line.sku} is not an active product. The system cannot use it for the price.`,
      }
    }

    const price: AppliedPrice = priceLine({
      basePriceCents: product.basePriceCents,
      quantity: line.quantity!,
      tier: { name: customer.tier, discountBp: customer.tierDiscountBp },
      quantityBreaks: breaks.get(product.sku) ?? [],
      override: overrides.get(product.sku) ?? null,
    })

    priced.push({
      position: line.position,
      requested: {
        reference: line.reference,
        description: line.description,
        sourceLabel: line.source_label,
        sourcePage: line.source_page,
      },
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      quantity: line.quantity!,
      pricing: {
        rule: price.rule,
        ruleLabel: price.ruleLabel,
        basePriceCents: price.basePriceCents,
        unitPriceCents: price.unitPriceCents,
        discountBp: price.discountBp,
        explanation: price.explanation,
      },
      subtotalCents: price.subtotalCents,
      match: {
        method: line.method ?? "unknown",
        confidenceLabel: line.confidence_label ?? "Review",
      },
    })
  }

  const source = await loadSource(env, runId)

  return {
    state: "ready",
    quote: {
      schema: QUOTE_SCHEMA,
      quoteNumber: await quoteNumber(runId),
      issuedAt: new Date().toISOString(),
      currency: "EUR",
      priceBasis: "excluding_vat",
      customer,
      source,
      lines: priced,
      totals: quoteTotals(priced),
      metadata: {
        generator: GENERATOR,
        schemaVersion: QUOTE_SCHEMA,
        pricingPrecedence: PRICING_PRECEDENCE,
        rounding: ROUNDING_NOTE,
        note: METADATA_NOTE,
      },
    },
  }
}

/** Stable, opaque, and derived from the run rather than from a counter. */
async function quoteNumber(runId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`quote:${runId}`)
  )

  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

  return `Q-${hex.slice(0, 10).toUpperCase()}`
}

async function loadCustomer(
  env: Env,
  resolution: ResolutionRow
): Promise<QuoteCustomer | null> {
  const customer = await env.DB.prepare(
    `SELECT id, name, tier, tier_discount_bp FROM catalog_customers WHERE id = ?`
  )
    .bind(resolution.customer_id)
    .first<{
      id: string
      name: string
      tier: string
      tier_discount_bp: number
    }>()

  if (!customer) return null

  const contact = resolution.contact_id
    ? await env.DB.prepare(
        `SELECT name, role, email FROM catalog_customer_contacts WHERE id = ?`
      )
        .bind(resolution.contact_id)
        .first<{ name: string; role: string; email: string }>()
    : null

  const location = resolution.location_id
    ? await env.DB.prepare(
        `SELECT label, street, postal_code, city, country
           FROM catalog_customer_locations WHERE id = ?`
      )
        .bind(resolution.location_id)
        .first<{
          label: string
          street: string
          postal_code: string
          city: string
          country: string
        }>()
    : null

  return {
    customerId: customer.id,
    name: customer.name,
    tier: customer.tier,
    tierDiscountBp: customer.tier_discount_bp,
    contact: contact
      ? { name: contact.name, role: contact.role, email: contact.email }
      : null,
    location: location
      ? {
          label: location.label,
          street: location.street,
          postalCode: location.postal_code,
          city: location.city,
          country: location.country,
        }
      : null,
  }
}

async function loadProducts(
  env: Env,
  skus: string[]
): Promise<
  Map<
    string,
    { sku: string; name: string; unit: string; basePriceCents: number }
  >
> {
  const placeholders = skus.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT sku, name, unit, base_price_cents FROM catalog_products
      WHERE sku IN (${placeholders}) AND status = 'active'`
  )
    .bind(...skus)
    .all<{
      sku: string
      name: string
      unit: string
      base_price_cents: number
    }>()

  return new Map(
    rows.results.map((row) => [
      row.sku,
      {
        sku: row.sku,
        name: row.name,
        unit: row.unit,
        basePriceCents: row.base_price_cents,
      },
    ])
  )
}

async function loadQuantityBreaks(
  env: Env,
  skus: string[]
): Promise<Map<string, { minQuantity: number; discountBp: number }[]>> {
  const placeholders = skus.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT sku, min_quantity, discount_bp FROM catalog_quantity_breaks
      WHERE sku IN (${placeholders}) ORDER BY sku ASC, min_quantity ASC`
  )
    .bind(...skus)
    .all<{ sku: string; min_quantity: number; discount_bp: number }>()

  const breaks = new Map<
    string,
    { minQuantity: number; discountBp: number }[]
  >()

  for (const row of rows.results) {
    const entry = {
      minQuantity: row.min_quantity,
      discountBp: row.discount_bp,
    }
    const existing = breaks.get(row.sku)

    if (existing) existing.push(entry)
    else breaks.set(row.sku, [entry])
  }

  return breaks
}

/**
 * Only active overrides. A superseded historical price is deliberately never
 * read, so it cannot win over the tier or a quantity break.
 */
async function loadActiveOverrides(
  env: Env,
  customerId: string,
  skus: string[]
): Promise<
  Map<string, { unitPriceCents: number; effectiveFrom: string; reason: string }>
> {
  const placeholders = skus.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT sku, unit_price_cents, effective_from, reason
       FROM catalog_price_overrides
      WHERE customer_id = ? AND active = 1 AND sku IN (${placeholders})
      ORDER BY sku ASC, effective_from DESC`
  )
    .bind(customerId, ...skus)
    .all<{
      sku: string
      unit_price_cents: number
      effective_from: string
      reason: string
    }>()

  const overrides = new Map<
    string,
    { unitPriceCents: number; effectiveFrom: string; reason: string }
  >()

  // The most recent active price for a product wins; earlier ones are history.
  for (const row of rows.results) {
    if (overrides.has(row.sku)) continue

    overrides.set(row.sku, {
      unitPriceCents: row.unit_price_cents,
      effectiveFrom: row.effective_from,
      reason: row.reason,
    })
  }

  return overrides
}

async function loadSource(env: Env, runId: string): Promise<QuoteSource> {
  const [rfq, documents] = await Promise.all([
    env.DB.prepare(
      `SELECT source_channel, source_subject, source_received_at,
              source_references
         FROM run_rfq WHERE run_id = ?`
    )
      .bind(runId)
      .first<{
        source_channel: string
        source_subject: string | null
        source_received_at: string | null
        source_references: string
      }>(),
    // Labels and media types only. A storage key never enters the quote.
    env.DB.prepare(
      `SELECT s.kind AS kind, s.label AS label, s.media_type AS media_type,
              (SELECT COUNT(*) FROM run_source_pages p
                WHERE p.run_id = s.run_id AND p.source_id = s.id) AS page_count
         FROM run_sources s WHERE s.run_id = ? ORDER BY s.position ASC`
    )
      .bind(runId)
      .all<{
        kind: string
        label: string
        media_type: string
        page_count: number
      }>(),
  ])

  // The references are what the request quoted at itself, carried along for a
  // reader; a column this build cannot read costs the quote those strings and
  // never the price.
  const references = STORED_SOURCE_REFERENCES_SCHEMA.safeParse(
    rfq?.source_references ?? "[]"
  )

  return {
    channel: rfq?.source_channel ?? "email",
    subject: rfq?.source_subject ?? null,
    receivedAt: rfq?.source_received_at ?? null,
    references: references.success ? references.data : [],
    documents: documents.results.map((row) => ({
      kind: row.kind,
      label: row.label,
      mediaType: row.media_type,
      pageCount: row.page_count,
    })),
  }
}
