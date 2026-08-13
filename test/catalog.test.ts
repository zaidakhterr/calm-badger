import { describe, expect, it } from "vitest"

import {
  CATALOG_SEED,
  catalogFingerprint,
  generateCatalog,
  type Catalog,
  type Product,
} from "../worker/catalog/dataset"
import { SCENARIOS } from "../worker/scenarios"
import { GOLD_SCENARIOS, goldScenario } from "./fixtures/gold-scenarios"

/**
 * Pinned so that any change to generation is a deliberate, reviewable one: the
 * committed seed SQL and the gold fixtures are only trustworthy while this
 * value holds.
 */
const EXPECTED_FINGERPRINT = "fcc1b36b"

const catalog = generateCatalog()

function product(catalogue: Catalog, sku: string): Product | undefined {
  return catalogue.products.find((candidate) => candidate.sku === sku)
}

describe("the synthetic distributor dataset", () => {
  it("is reproducible from its fixed seed", () => {
    const again = generateCatalog(CATALOG_SEED)

    expect(catalogFingerprint(catalog)).toBe(EXPECTED_FINGERPRINT)
    expect(catalogFingerprint(again)).toBe(EXPECTED_FINGERPRINT)
    expect(JSON.stringify(again)).toBe(JSON.stringify(catalog))
    expect(catalogFingerprint(generateCatalog(CATALOG_SEED + 1))).not.toBe(
      EXPECTED_FINGERPRINT
    )
  })

  it("has the scale the demo claims", () => {
    expect(catalog.products).toHaveLength(250)
    expect(catalog.customers).toHaveLength(25)
    expect(catalog.orders.length).toBeGreaterThanOrEqual(140)
    expect(catalog.orders.length).toBeLessThanOrEqual(160)

    const skus = new Set(catalog.products.map((entry) => entry.sku))
    expect(skus.size).toBe(catalog.products.length)
  })

  it("gives every customer realistic contacts and locations", () => {
    for (const customer of catalog.customers) {
      expect(customer.contacts.length).toBeGreaterThanOrEqual(2)
      expect(customer.contacts.length).toBeLessThanOrEqual(4)
      expect(customer.locations.length).toBeGreaterThanOrEqual(1)
      expect(customer.locations.length).toBeLessThanOrEqual(3)

      for (const contact of customer.contacts) {
        expect(contact.email.endsWith(`@${customer.domain}`)).toBe(true)
      }
    }
  })

  it("is deliberately messy", () => {
    const aliases = catalog.products.flatMap((entry) => entry.aliases)

    expect(
      aliases.filter((alias) => alias.kind === "alias").length
    ).toBeGreaterThan(50)
    expect(
      aliases.filter((alias) => alias.kind === "typo").length
    ).toBeGreaterThan(20)
    expect(
      aliases.filter((alias) => alias.kind === "legacy").length
    ).toBeGreaterThan(10)
    expect(
      aliases.filter((alias) => alias.customerId !== null).length
    ).toBeGreaterThan(0)

    // An alias that names two products would silently break exact-alias
    // acceptance, so ambiguity has to come from descriptions instead.
    const byAlias = new Map<string, number>()
    for (const alias of aliases) {
      byAlias.set(alias.alias, (byAlias.get(alias.alias) ?? 0) + 1)
    }
    expect([...byAlias.values()].filter((count) => count > 1)).toHaveLength(0)

    const archived = catalog.products.filter(
      (entry) => entry.status === "archived"
    )
    expect(archived.length).toBeGreaterThan(5)
    for (const entry of archived) {
      if (!entry.replacementSku) continue
      expect(product(catalog, entry.replacementSku)?.status).toBe("active")
    }

    const nearDuplicates = catalog.products.filter(
      (entry) => entry.nearDuplicateOf
    )
    expect(nearDuplicates.length).toBeGreaterThan(10)
    for (const entry of nearDuplicates) {
      expect(product(catalog, entry.nearDuplicateOf!)).toBeDefined()
    }
  })

  it("carries the pricing facts the estimate needs", () => {
    const tiers = new Set(catalog.customers.map((entry) => entry.tier))
    expect([...tiers].sort()).toEqual(["key", "preferred", "standard"])

    const withBreaks = catalog.products.filter(
      (entry) => entry.quantityBreaks.length > 0
    )
    expect(withBreaks.length).toBeGreaterThan(50)
    for (const entry of withBreaks) {
      for (const quantityBreak of entry.quantityBreaks) {
        expect(quantityBreak.minQuantity).toBeGreaterThan(1)
        expect(quantityBreak.discountBp).toBeGreaterThan(0)
        expect(quantityBreak.discountBp).toBeLessThan(5000)
      }
    }

    expect(
      catalog.priceOverrides.filter((entry) => entry.active).length
    ).toBeGreaterThan(0)
    expect(
      catalog.priceOverrides.filter((entry) => !entry.active).length
    ).toBeGreaterThan(0)

    for (const override of catalog.priceOverrides) {
      expect(product(catalog, override.sku)).toBeDefined()
      expect(
        catalog.customers.some((entry) => entry.id === override.customerId)
      ).toBe(true)
      expect(override.unitPriceCents).toBeGreaterThan(0)
    }
  })

  it("only sells stocked products in its order history", () => {
    for (const order of catalog.orders) {
      const customer = catalog.customers.find(
        (entry) => entry.id === order.customerId
      )
      expect(customer).toBeDefined()
      expect(
        customer!.contacts.some((entry) => entry.id === order.contactId)
      ).toBe(true)
      expect(
        customer!.locations.some((entry) => entry.id === order.locationId)
      ).toBe(true)
      expect(order.lines.length).toBeGreaterThan(0)

      for (const line of order.lines) {
        expect(product(catalog, line.sku)?.status).toBe("active")
        expect(line.quantity).toBeGreaterThan(0)
        expect(line.unitPriceCents).toBeGreaterThan(0)
      }
    }
  })
})

describe("gold expectations for the curated scenarios", () => {
  it("covers every scenario exactly once", () => {
    expect(GOLD_SCENARIOS.map((gold) => gold.scenarioId).sort()).toEqual(
      SCENARIOS.map((scenario) => scenario.id).sort()
    )
  })

  it("resolves against the generated dataset", () => {
    for (const gold of GOLD_SCENARIOS) {
      const customer = catalog.customers.find(
        (entry) => entry.id === gold.customer.customerId
      )
      expect(customer, gold.scenarioId).toBeDefined()
      expect(
        customer!.contacts.some(
          (contact) => contact.email === gold.customer.contactEmail
        )
      ).toBe(true)
      expect(
        customer!.locations.some(
          (location) => location.id === gold.customer.locationId
        )
      ).toBe(true)

      for (const match of gold.matches) {
        const expected = product(catalog, match.expectedSku)
        expect(expected, `${gold.scenarioId} #${match.position}`).toBeDefined()
        expect(expected!.status).toBe("active")

        for (const alternative of match.alternatives) {
          expect(product(catalog, alternative)).toBeDefined()
        }
      }
    }
  })

  it("is decidable from catalogue evidence", () => {
    for (const gold of GOLD_SCENARIOS) {
      for (const match of gold.matches) {
        const aliases = catalog.products.flatMap((entry) =>
          entry.aliases.map((alias) => ({ sku: entry.sku, ...alias }))
        )

        if (match.basis === "sku") {
          expect(match.sourceReference).toBe(match.expectedSku)
        }

        if (match.basis === "alias" || match.basis === "typo_alias") {
          const reference = match.sourceReference.toLowerCase()
          const supporting = aliases.filter(
            (alias) =>
              alias.sku === match.expectedSku &&
              (reference.includes(alias.alias.toLowerCase()) ||
                alias.alias.toLowerCase().includes(reference))
          )
          expect(
            supporting.length,
            `${gold.scenarioId} #${match.position}`
          ).toBeGreaterThan(0)
        }

        if (match.basis === "legacy_alias") {
          // A superseded number must lead to an archived product whose
          // successor is the expected answer.
          const legacy = aliases.find(
            (alias) =>
              alias.kind === "legacy" &&
              match.sourceReference
                .toLowerCase()
                .includes(alias.alias.toLowerCase())
          )
          expect(legacy, `${gold.scenarioId} #${match.position}`).toBeDefined()
          const archived = product(catalog, legacy!.sku)!
          expect(archived.status).toBe("archived")
          expect(archived.replacementSku).toBe(match.expectedSku)
          expect(match.alternatives).toContain(archived.sku)
        }
      }
    }
  })

  it("only asks for review where the catalogue is genuinely ambiguous", () => {
    for (const gold of GOLD_SCENARIOS) {
      const reviewPositions = gold.matches
        .filter((match) => match.decision === "review")
        .map((match) => match.position)

      expect(reviewPositions).toEqual(gold.expectedReviewPositions)

      for (const match of gold.matches) {
        if (match.decision !== "review") continue

        const expected = product(catalog, match.expectedSku)!
        const contested = match.alternatives.map((sku) =>
          product(catalog, sku)!
        )

        const ambiguous = contested.some(
          (alternative) =>
            alternative.status === "archived" ||
            alternative.nearDuplicateOf === expected.sku ||
            expected.nearDuplicateOf === alternative.sku
        )

        expect(ambiguous, `${gold.scenarioId} #${match.position}`).toBe(true)
      }
    }
  })

  it("expects the featured scenario to pause and the routine one to finish", () => {
    expect(
      goldScenario("routine-replenishment").expectedReviewPositions
    ).toEqual([])
    expect(
      goldScenario("messy-forwarded-request").expectedReviewPositions.length
    ).toBeGreaterThan(0)
    expect(
      goldScenario("ambiguous-replacement-parts").expectedReviewPositions.length
    ).toBeGreaterThan(0)
  })

  it("matches the six requested lines of each scenario", () => {
    for (const scenario of SCENARIOS) {
      const gold = goldScenario(scenario.id)

      expect(scenario.requestedItems).toHaveLength(6)
      expect(gold.matches).toHaveLength(6)
      expect(gold.extraction.lineItemCount).toBe(6)

      for (const item of scenario.requestedItems) {
        const match = gold.matches.find(
          (entry) => entry.position === item.position
        )
        expect(match, `${scenario.id} #${item.position}`).toBeDefined()
        expect(match!.quantity).toBe(item.quantity)
        expect(match!.sourceReference).toBe(item.reference)
      }
    }
  })
})
