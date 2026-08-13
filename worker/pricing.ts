/**
 * Deterministic pricing.
 *
 * No model is asked for a number here, and nothing in this file reads a
 * database: it is given the catalogue facts for one line and returns the price
 * those facts imply, so every rule and every combination of rules can be
 * enumerated in a test.
 *
 * Precedence, exactly as the specification documents it:
 *
 *   1. an active customer-specific historical override;
 *   2. the customer's pricing tier;
 *   3. a quantity-break discount;
 *   4. the catalogue base price.
 *
 * It is an ordered fallback, not a search for the cheapest answer. The first
 * applicable rule wins, so a tiered customer is quoted their tier price even
 * when a quantity break would have discounted further. That is a business
 * decision rather than an accident, which is why every line records which rule
 * applied and what it did.
 *
 * `priceFor` in `worker/catalog/dataset.ts` deliberately does *not* agree with
 * this. That function writes the synthetic order history, where a past order
 * reads more believably if it took the better of the tier and a quantity break,
 * so it picks the larger discount. This file is the pricing contract every
 * quote is held to, and it is the ordered fallback above. The divergence is
 * intentional: history is decoration, this is the rule.
 *
 * Money is integer cents from end to end; no amount is ever held as a float
 * fraction of a euro. A discounted unit price is rounded once, to the nearest
 * cent, with halves going up (`Math.round`). A line subtotal is then an exact
 * integer multiplication of that rounded unit price by the quantity, so the
 * line total always equals the unit price a reader can see. VAT is rounded once
 * over the whole subtotal rather than per line, which is what keeps the printed
 * lines, the VAT amount, and the total consistent with one another.
 */

/** Applied-rule identifiers. They are stable and safe to show. */
export type PricingRule =
  "historical_override" | "customer_tier" | "quantity_break" | "catalog_base"

export type QuantityBreak = {
  minQuantity: number
  discountBp: number
}

export type PricingTier = {
  /** `standard`, `preferred`, `key` — shown as-is beside the discount. */
  name: string
  discountBp: number
}

export type HistoricalOverride = {
  unitPriceCents: number
  effectiveFrom: string
  reason: string
}

export type PriceInput = {
  basePriceCents: number
  quantity: number
  /** Absent for a run whose customer was never resolved. */
  tier: PricingTier | null
  quantityBreaks: QuantityBreak[]
  /** Only ever an *active* override; a superseded one is not passed here. */
  override: HistoricalOverride | null
}

export type AppliedPrice = {
  rule: PricingRule
  ruleLabel: string
  basePriceCents: number
  unitPriceCents: number
  /** The discount the applied rule carried, in basis points; null for a price. */
  discountBp: number | null
  quantity: number
  subtotalCents: number
  /** One sentence a reviewer can check the arithmetic against. */
  explanation: string
}

/** German standard rate, in basis points. */
export const VAT_RATE_BP = 1900

export const ROUNDING_NOTE =
  "Amounts are integer cents. A discounted unit price is rounded to the nearest cent (halves up) once, the line subtotal is that rounded unit price times the quantity, and VAT is rounded once over the whole subtotal rather than per line."

export function priceLine(input: PriceInput): AppliedPrice {
  const { basePriceCents, quantity, tier, quantityBreaks, override } = input

  if (override) {
    return applied({
      rule: "historical_override",
      ruleLabel: "Historical override",
      basePriceCents,
      unitPriceCents: override.unitPriceCents,
      discountBp: null,
      quantity,
      explanation: `An active customer price of ${money(override.unitPriceCents)} applies (${override.reason}, effective ${override.effectiveFrom}), so the ${money(basePriceCents)} catalogue price is not used.`,
    })
  }

  if (tier && tier.discountBp > 0) {
    const unitPriceCents = discounted(basePriceCents, tier.discountBp)

    return applied({
      rule: "customer_tier",
      ruleLabel: "Customer tier",
      basePriceCents,
      unitPriceCents,
      discountBp: tier.discountBp,
      quantity,
      explanation: `The ${tier.name} tier discounts the ${money(basePriceCents)} catalogue price by ${percent(tier.discountBp)} to ${money(unitPriceCents)}.`,
    })
  }

  const quantityBreak = deepestBreak(quantityBreaks, quantity)

  if (quantityBreak) {
    const unitPriceCents = discounted(basePriceCents, quantityBreak.discountBp)

    return applied({
      rule: "quantity_break",
      ruleLabel: "Quantity break",
      basePriceCents,
      unitPriceCents,
      discountBp: quantityBreak.discountBp,
      quantity,
      explanation: `Ordering ${quantity} reaches the ${quantityBreak.minQuantity}+ break, which discounts the ${money(basePriceCents)} catalogue price by ${percent(quantityBreak.discountBp)} to ${money(unitPriceCents)}.`,
    })
  }

  return applied({
    rule: "catalog_base",
    ruleLabel: "Catalogue base price",
    basePriceCents,
    unitPriceCents: basePriceCents,
    discountBp: null,
    quantity,
    explanation: `No customer price, tier discount, or quantity break applies, so the ${money(basePriceCents)} catalogue price stands.`,
  })
}

export type QuoteTotals = {
  lineCount: number
  subtotalCents: number
  vatRateBp: number
  vatCents: number
  totalCents: number
}

/** Subtotal excludes VAT; VAT is applied once, over the whole subtotal. */
export function quoteTotals(lines: { subtotalCents: number }[]): QuoteTotals {
  const subtotalCents = lines.reduce(
    (total, line) => total + line.subtotalCents,
    0
  )
  const vatCents = Math.round((subtotalCents * VAT_RATE_BP) / 10_000)

  return {
    lineCount: lines.length,
    subtotalCents,
    vatRateBp: VAT_RATE_BP,
    vatCents,
    totalCents: subtotalCents + vatCents,
  }
}

/**
 * The deepest break the quantity reaches. Breaks are listed by minimum
 * quantity, and a larger order can only ever qualify for a better one.
 */
function deepestBreak(
  breaks: QuantityBreak[],
  quantity: number
): QuantityBreak | null {
  return (
    [...breaks]
      .filter((entry) => quantity >= entry.minQuantity)
      .sort(
        (left, right) =>
          right.minQuantity - left.minQuantity ||
          right.discountBp - left.discountBp
      )[0] ?? null
  )
}

function discounted(basePriceCents: number, discountBp: number): number {
  return Math.round((basePriceCents * (10_000 - discountBp)) / 10_000)
}

function applied(price: Omit<AppliedPrice, "subtotalCents">): AppliedPrice {
  return { ...price, subtotalCents: price.unitPriceCents * price.quantity }
}

/** EUR, for evidence prose only. Stored and transported amounts stay integers. */
export function money(cents: number): string {
  return `€${formatAmount(cents)}`
}

/** `1490` → `14.90`. The decimal form adapters and the interface print. */
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(cents)

  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`
}

function percent(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`
}
