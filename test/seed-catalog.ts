/**
 * Loads the synthetic distributor dataset into the test database.
 *
 * Customer resolution and business validation are deterministic lookups against
 * seeded catalogue rows, so the workflow contract can only be exercised with
 * that data present. The rows come from the same generator the committed
 * `seed/catalog.sql` is built from, which `pnpm data:check` keeps in agreement,
 * so a test never disagrees with a deployed database.
 */

import { generateCatalog } from "../worker/catalog/dataset"

let seeded = false

export async function seedCatalog(db: D1Database): Promise<void> {
  if (seeded) return
  seeded = true

  const catalog = generateCatalog()
  const statements: D1PreparedStatement[] = []

  for (const product of catalog.products) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO catalog_products (
             sku, name, description, category, manufacturer, unit,
             base_price_cents, status, replacement_sku, near_duplicate_of
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          product.sku,
          product.name,
          product.description,
          product.category,
          product.manufacturer,
          product.unit,
          product.basePriceCents,
          product.status,
          product.replacementSku,
          product.nearDuplicateOf
        )
    )

    for (const alias of product.aliases) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO catalog_product_aliases
               (sku, alias, alias_kind, customer_id) VALUES (?, ?, ?, ?)`
          )
          .bind(product.sku, alias.alias, alias.kind, alias.customerId)
      )
    }

    for (const load of product.quantityBreaks) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO catalog_quantity_breaks
               (sku, min_quantity, discount_bp) VALUES (?, ?, ?)`
          )
          .bind(product.sku, load.minQuantity, load.discountBp)
      )
    }
  }

  for (const customer of catalog.customers) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO catalog_customers
             (id, name, domain, tier, tier_discount_bp) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          customer.id,
          customer.name,
          customer.domain,
          customer.tier,
          customer.tierDiscountBp
        )
    )

    for (const contact of customer.contacts) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO catalog_customer_contacts
               (id, customer_id, name, email, phone, role)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            contact.id,
            customer.id,
            contact.name,
            contact.email,
            contact.phone,
            contact.role
          )
      )
    }

    for (const location of customer.locations) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO catalog_customer_locations
               (id, customer_id, label, street, postal_code, city, country)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            location.id,
            customer.id,
            location.label,
            location.street,
            location.postalCode,
            location.city,
            location.country
          )
      )
    }
  }

  for (const override of catalog.priceOverrides) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO catalog_price_overrides
             (customer_id, sku, unit_price_cents, effective_from, active, reason)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          override.customerId,
          override.sku,
          override.unitPriceCents,
          override.effectiveFrom,
          override.active ? 1 : 0,
          override.reason
        )
    )
  }

  for (const order of catalog.orders) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO catalog_orders
             (id, customer_id, contact_id, location_id, ordered_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          order.id,
          order.customerId,
          order.contactId,
          order.locationId,
          order.orderedAt
        )
    )

    for (const line of order.lines) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO catalog_order_lines
               (order_id, position, sku, quantity, unit_price_cents, applied_rule)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            order.id,
            line.position,
            line.sku,
            line.quantity,
            line.unitPriceCents,
            line.appliedRule
          )
      )
    }
  }

  // Batched in slices: one statement per row keeps the seed readable, and D1
  // rejects an unbounded batch.
  for (let index = 0; index < statements.length; index += 200) {
    await db.batch(statements.slice(index, index + 200))
  }
}
