/**
 * Simulated delivery adapters.
 *
 * The Generic ERP Webhook is the sole delivery destination. It receives the
 * canonical quote and returns the payload a receiver would see plus a synthetic
 * acknowledgement. It never opens a socket: no request leaves this Worker and
 * no credential exists for it.
 *
 * The transformation is pure and deterministic: the same quote always
 * produces the same payload and synthetic identifier.
 */

import type { CanonicalQuote } from "./quote"

export const ADAPTER_IDS = ["generic-erp-webhook"] as const

export type AdapterId = (typeof ADAPTER_IDS)[number]

export function isAdapterId(value: unknown): value is AdapterId {
  return typeof value === "string" && ADAPTER_IDS.includes(value as AdapterId)
}

/** The sole destination used for every new delivery. */
export const DEFAULT_ADAPTER: AdapterId = "generic-erp-webhook"

export const SIMULATION_NOTICE =
  "Simulated locally. This adapter transforms the canonical quote and returns a synthetic identifier; no request leaves the application, no third-party system is contacted, and no affiliation or endorsement is implied."

export type AdapterDescription = {
  id: string
  name: string
  /** How the payload is shaped, in one line, before a reviewer reads it. */
  contract: string
  payloadFormat: string
  simulated: true
  notice: string
}

export const ADAPTERS: Record<AdapterId, AdapterDescription> = {
  "generic-erp-webhook": {
    id: "generic-erp-webhook",
    name: "Generic ERP Webhook",
    contract:
      "Event-oriented webhook envelope: a versioned event name, a flat snake_case body, and every amount as an integer in minor units.",
    payloadFormat: "JSON event, snake_case, integer minor units",
    simulated: true,
    notice: SIMULATION_NOTICE,
  },
}

export type AdapterDelivery = {
  adapter: AdapterDescription
  /** Exactly what the receiving system would be sent. */
  payload: unknown
  /** The synthetic acknowledgement the adapter returns. */
  receipt: {
    externalEstimateId: string
    acceptedAt: string
    status: "accepted"
    simulated: true
    notice: string
  }
}

/** The payload a reviewer may inspect before deciding to deliver. */
export function buildAdapterPayload(quote: CanonicalQuote): unknown {
  return toGenericErpEvent(quote)
}

/**
 * "Delivers" the quote: transforms it, and returns the synthetic identifier the
 * receiving system would have issued. `acceptedAt` is the only part that is not
 * a function of the quote.
 */
export function deliverQuote(
  quote: CanonicalQuote,
  acceptedAt: string
): AdapterDelivery {
  return {
    adapter: ADAPTERS[DEFAULT_ADAPTER],
    payload: buildAdapterPayload(quote),
    receipt: {
      externalEstimateId: externalEstimateId(quote.quoteNumber),
      acceptedAt,
      status: "accepted",
      simulated: true,
      notice: SIMULATION_NOTICE,
    },
  }
}

/**
 * A synthetic identifier in the shape each system uses, derived from the quote
 * so the same quote always produces the same one. It is not an identifier in
 * any real system.
 */
export function externalEstimateId(quoteNumber: string): string {
  const digits = fingerprint(`${DEFAULT_ADAPTER}:${quoteNumber}`)
  return `ERP-SIM-${digits.slice(0, 6)}-${digits.slice(6, 10)}`
}

/** Description for a delivery persisted by this or an earlier build. */
export function storedAdapterDescription(id: string): AdapterDescription {
  if (isAdapterId(id)) return ADAPTERS[id]

  return {
    id,
    name: id === "corebridge-sandbox" ? "CoreBridge Sandbox" : "Legacy adapter",
    contract: "Historical simulated delivery retained for read compatibility.",
    payloadFormat: "Stored JSON payload",
    simulated: true,
    notice: SIMULATION_NOTICE,
  }
}

/* -------------------------------------------------------------------------- */
/* Generic ERP Webhook — a flat event envelope                                */
/* -------------------------------------------------------------------------- */

function toGenericErpEvent(quote: CanonicalQuote) {
  return {
    event: "quote.created",
    event_version: 1,
    idempotency_key: quote.quoteNumber,
    simulated: true,
    data: {
      quote_id: quote.quoteNumber,
      issued_at: quote.issuedAt,
      currency: quote.currency,
      amount_scale: "minor_units",
      prices_include_tax: false,
      customer_id: quote.customer.customerId,
      customer_name: quote.customer.name,
      customer_tier: quote.customer.tier,
      customer_tier_discount_bp: quote.customer.tierDiscountBp,
      contact_email: quote.customer.contact?.email ?? null,
      ship_to_city: quote.customer.location?.city ?? null,
      ship_to_country: quote.customer.location?.country ?? null,
      ship_to_postal_code: quote.customer.location?.postalCode ?? null,
      items: quote.lines.map((line) => ({
        line_no: line.position,
        sku: line.sku,
        description: line.name,
        uom: line.unit,
        qty: line.quantity,
        unit_price: line.pricing.unitPriceCents,
        list_price: line.pricing.basePriceCents,
        line_total: line.subtotalCents,
        pricing_rule: line.pricing.rule,
        discount_bp: line.pricing.discountBp,
      })),
      subtotal: quote.totals.subtotalCents,
      tax_rate_bp: quote.totals.vatRateBp,
      tax_total: quote.totals.vatCents,
      grand_total: quote.totals.totalCents,
      source_channel: quote.source.channel,
      source_references: quote.source.references,
      source_document_count: quote.source.documents.length,
    },
    notice: SIMULATION_NOTICE,
  }
}

/** A short stable digit string; enough to look like an identifier, no more. */
function fingerprint(input: string): string {
  // FNV-1a. Deterministic, dependency-free, and never used for anything that
  // needs to resist an attacker.
  let hash = 0x811c9dc5

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return String(hash).padStart(10, "0").slice(0, 10)
}
