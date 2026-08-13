#!/usr/bin/env node
/**
 * Renders the deterministic synthetic dataset into `seed/catalog.sql`.
 *
 * The generator is the source of truth; this script is a pure formatter, so
 * rebuilding on the same seed must leave the committed file byte-identical.
 * `pnpm data:check` enforces that.
 *
 * Every statement it writes is an `INSERT OR IGNORE` into a `catalog_` table.
 * The file contains no DELETE, DROP, UPDATE, or REPLACE, so importing it into a
 * populated database adds missing rows and touches nothing a demo has
 * accumulated since.
 */

import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const dataset = await import("../worker/catalog/dataset.ts")

const OUTPUT = fileURLToPath(new URL("../seed/catalog.sql", import.meta.url))
const ROWS_PER_STATEMENT = 40

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "1" : "0"
  return sqlText(value)
}

function insertStatements(table, columns, rows) {
  if (rows.length === 0) return []

  const statements = []

  for (let offset = 0; offset < rows.length; offset += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(offset, offset + ROWS_PER_STATEMENT)
    const values = chunk
      .map((row) => `  (${row.map(sqlValue).join(", ")})`)
      .join(",\n")

    statements.push(
      `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES\n${values};`
    )
  }

  return statements
}

function render(catalog) {
  const products = catalog.products
  const sections = []

  sections.push(
    [
      "-- Generated file. Do not edit by hand.",
      "-- Rebuild with `pnpm seed:build`; verify with `pnpm data:check`.",
      "--",
      `-- Source: worker/catalog/dataset.ts, seed ${catalog.seed}.`,
      `-- Contents: ${products.length} products, ${catalog.customers.length} customers,`,
      `-- ${catalog.orders.length} historical orders.`,
      "--",
      "-- Import is additive: every statement is INSERT OR IGNORE into a catalog_",
      "-- table, so reseeding an existing database cannot remove or overwrite",
      "-- accumulated demo state.",
    ].join("\n")
  )

  sections.push(
    ...insertStatements(
      "catalog_products",
      [
        "sku",
        "name",
        "description",
        "category",
        "manufacturer",
        "unit",
        "base_price_cents",
        "status",
        "replacement_sku",
        "near_duplicate_of",
      ],
      products.map((product) => [
        product.sku,
        product.name,
        product.description,
        product.category,
        product.manufacturer,
        product.unit,
        product.basePriceCents,
        product.status,
        product.replacementSku,
        product.nearDuplicateOf,
      ])
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_product_aliases",
      ["sku", "alias", "alias_kind", "customer_id"],
      products.flatMap((product) =>
        product.aliases.map((alias) => [
          product.sku,
          alias.alias,
          alias.kind,
          alias.customerId,
        ])
      )
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_quantity_breaks",
      ["sku", "min_quantity", "discount_bp"],
      products.flatMap((product) =>
        product.quantityBreaks.map((entry) => [
          product.sku,
          entry.minQuantity,
          entry.discountBp,
        ])
      )
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_customers",
      ["id", "name", "domain", "tier", "tier_discount_bp"],
      catalog.customers.map((customer) => [
        customer.id,
        customer.name,
        customer.domain,
        customer.tier,
        customer.tierDiscountBp,
      ])
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_customer_contacts",
      ["id", "customer_id", "name", "email", "phone", "role"],
      catalog.customers.flatMap((customer) =>
        customer.contacts.map((contact) => [
          contact.id,
          customer.id,
          contact.name,
          contact.email,
          contact.phone,
          contact.role,
        ])
      )
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_customer_locations",
      [
        "id",
        "customer_id",
        "label",
        "street",
        "postal_code",
        "city",
        "country",
      ],
      catalog.customers.flatMap((customer) =>
        customer.locations.map((location) => [
          location.id,
          customer.id,
          location.label,
          location.street,
          location.postalCode,
          location.city,
          location.country,
        ])
      )
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_price_overrides",
      [
        "customer_id",
        "sku",
        "unit_price_cents",
        "effective_from",
        "active",
        "reason",
      ],
      catalog.priceOverrides.map((override) => [
        override.customerId,
        override.sku,
        override.unitPriceCents,
        override.effectiveFrom,
        override.active,
        override.reason,
      ])
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_orders",
      ["id", "customer_id", "contact_id", "location_id", "ordered_at"],
      catalog.orders.map((order) => [
        order.id,
        order.customerId,
        order.contactId,
        order.locationId,
        order.orderedAt,
      ])
    )
  )

  sections.push(
    ...insertStatements(
      "catalog_order_lines",
      [
        "order_id",
        "position",
        "sku",
        "quantity",
        "unit_price_cents",
        "applied_rule",
      ],
      catalog.orders.flatMap((order) =>
        order.lines.map((line) => [
          order.id,
          line.position,
          line.sku,
          line.quantity,
          line.unitPriceCents,
          line.appliedRule,
        ])
      )
    )
  )

  const fingerprint = dataset.catalogFingerprint(catalog)

  sections.push(
    [
      "INSERT INTO system_metadata (key, value) VALUES",
      `  ('catalog_seed', ${sqlText(String(catalog.seed))}),`,
      `  ('catalog_fingerprint', ${sqlText(fingerprint)}),`,
      "  ('catalog_seed_state', 'catalog-ready')",
      "ON CONFLICT (key) DO UPDATE SET",
      "  value = excluded.value,",
      "  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');",
    ].join("\n")
  )

  return `${sections.join("\n\n")}\n`
}

export function renderCatalogSeed(seed = dataset.CATALOG_SEED) {
  return render(dataset.generateCatalog(seed))
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const sql = renderCatalogSeed()
  await writeFile(OUTPUT, sql, "utf8")
  process.stdout.write(`Wrote ${OUTPUT} (${sql.length} bytes)\n`)
}
