import { describe, expect, it } from "vitest"

import {
  CATALOG_SEED,
  catalogFingerprint,
  generateCatalog,
  type Catalog,
  type Product,
} from "../worker/catalog/dataset"

/**
 * Pinned so that any change to generation is a deliberate, reviewable one: the
 * committed seed SQL are only trustworthy while this
 * value holds.
 */
const EXPECTED_FINGERPRINT = "b09dc2e0"

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
