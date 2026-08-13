/**
 * Simulated delivery adapters.
 *
 * Both adapters implement one export contract: they are handed the canonical
 * quote and nothing else, and they return the payload a receiving system would
 * see plus a synthetic acknowledgement. Neither of them opens a socket. No
 * request leaves this Worker, no credential exists for them, and their names
 * describe shapes rather than products: "CoreBridge Sandbox" is a fictional
 * business system invented for this demo, and nothing here implies connectivity
 * with, affiliation with, or endorsement by any real vendor.
 *
 * The two payloads are deliberately designed apart rather than renamed copies
 * of each other, because the point of the boundary is that one stable canonical
 * document can satisfy genuinely different receivers:
 *
 * - CoreBridge Sandbox is document-oriented: a nested sales estimate with a
 *   partner block, positions, a tax table, and decimal-string amounts.
 * - Generic ERP Webhook is event-oriented: a flat snake_case envelope with a
 *   versioned event name and every amount as an integer in minor units.
 *
 * Both transformations are pure and deterministic: the same quote always
 * produces the same payload and the same synthetic identifier, which is what
 * makes them worth snapshotting.
 */

import { formatAmount, type PricingRule } from "./pricing"
import type { CanonicalQuote } from "./quote"

export const ADAPTER_IDS = [
  "corebridge-sandbox",
  "generic-erp-webhook",
] as const

export type AdapterId = (typeof ADAPTER_IDS)[number]

export function isAdapterId(value: unknown): value is AdapterId {
  return typeof value === "string" && ADAPTER_IDS.includes(value as AdapterId)
}

/** Preselected in the interface, and labelled simulated wherever it appears. */
export const DEFAULT_ADAPTER: AdapterId = "corebridge-sandbox"

export const SIMULATION_NOTICE =
  "Simulated locally. This adapter transforms the canonical quote and returns a synthetic identifier; no request leaves the application, no third-party system is contacted, and no affiliation or endorsement is implied."

export type AdapterDescription = {
  id: AdapterId
  name: string
  /** How the payload is shaped, in one line, before a reviewer reads it. */
  contract: string
  payloadFormat: string
  simulated: true
  notice: string
}

export const ADAPTERS: Record<AdapterId, AdapterDescription> = {
  "corebridge-sandbox": {
    id: "corebridge-sandbox",
    name: "CoreBridge Sandbox",
    contract:
      "Document-oriented sales estimate: a nested partner block, numbered positions, a tax table, and amounts as decimal strings.",
    payloadFormat: "JSON document, camelCase, decimal string amounts",
    simulated: true,
    notice: SIMULATION_NOTICE,
  },
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
export function buildAdapterPayload(
  adapter: AdapterId,
  quote: CanonicalQuote
): unknown {
  return adapter === "corebridge-sandbox"
    ? toCoreBridgeDocument(quote)
    : toGenericErpEvent(quote)
}

/**
 * "Delivers" the quote: transforms it, and returns the synthetic identifier the
 * receiving system would have issued. `acceptedAt` is the only part that is not
 * a function of the quote.
 */
export function deliverQuote(
  adapter: AdapterId,
  quote: CanonicalQuote,
  acceptedAt: string
): AdapterDelivery {
  return {
    adapter: ADAPTERS[adapter],
    payload: buildAdapterPayload(adapter, quote),
    receipt: {
      externalEstimateId: externalEstimateId(adapter, quote.quoteNumber),
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
export function externalEstimateId(
  adapter: AdapterId,
  quoteNumber: string
): string {
  const digits = fingerprint(`${adapter}:${quoteNumber}`)

  return adapter === "corebridge-sandbox"
    ? `CBX-SBX-${digits.slice(0, 8)}`
    : `ERP-SIM-${digits.slice(0, 6)}-${digits.slice(6, 10)}`
}

/* -------------------------------------------------------------------------- */
/* CoreBridge Sandbox — a nested estimate document                            */
/* -------------------------------------------------------------------------- */

const PRICE_ORIGIN: Record<PricingRule, string> = {
  historical_override: "CONTRACT_PRICE",
  customer_tier: "PRICE_GROUP",
  quantity_break: "VOLUME_SCALE",
  catalog_base: "LIST_PRICE",
}

function toCoreBridgeDocument(quote: CanonicalQuote) {
  return {
    documentType: "SALES_ESTIMATE",
    sandbox: true,
    estimate: {
      reference: quote.quoteNumber,
      issuedOn: quote.issuedAt.slice(0, 10),
      currency: quote.currency,
      priceMode: "NET",
      partner: {
        partnerCode: quote.customer.customerId,
        legalName: quote.customer.name,
        priceGroup: quote.customer.tier.toUpperCase(),
        contact: quote.customer.contact
          ? {
              fullName: quote.customer.contact.name,
              function: quote.customer.contact.role,
              emailAddress: quote.customer.contact.email,
            }
          : null,
      },
      shipTo: quote.customer.location
        ? {
            siteName: quote.customer.location.label,
            addressLine: quote.customer.location.street,
            postalCode: quote.customer.location.postalCode,
            city: quote.customer.location.city,
            countryCode: quote.customer.location.country,
          }
        : null,
      positions: quote.lines.map((line) => ({
        position: line.position,
        articleCode: line.sku,
        articleName: line.name,
        unitOfMeasure: line.unit,
        quantity: line.quantity,
        netUnitPrice: formatAmount(line.pricing.unitPriceCents),
        netAmount: formatAmount(line.subtotalCents),
        priceOrigin: PRICE_ORIGIN[line.pricing.rule],
        priceNote: line.pricing.explanation,
      })),
      taxes: [
        {
          code: "DE-VAT-STANDARD",
          ratePercent: formatAmount(quote.totals.vatRateBp),
          baseAmount: formatAmount(quote.totals.subtotalCents),
          taxAmount: formatAmount(quote.totals.vatCents),
        },
      ],
      summary: {
        netTotal: formatAmount(quote.totals.subtotalCents),
        taxTotal: formatAmount(quote.totals.vatCents),
        grossTotal: formatAmount(quote.totals.totalCents),
        positionCount: quote.totals.lineCount,
      },
    },
    origin: {
      system: quote.metadata.generator,
      channel: quote.source.channel,
      documentReferences: quote.source.references,
      attachments: quote.source.documents.map(
        (document) => `${document.label} (${document.mediaType})`
      ),
    },
    disclaimer: SIMULATION_NOTICE,
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
