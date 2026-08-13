/**
 * Seed import contract.
 *
 * The committed `seed/catalog.sql` must be a faithful, byte-stable rendering of
 * the fixed-seed generator, and importing it must be safe on a database that a
 * demo has already been running against. These checks use an in-process SQLite
 * database so they stay part of the ordinary `pnpm check` run.
 */

import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const seedSql = readFileSync(`${repoRoot}seed/catalog.sql`, "utf8")

const { renderCatalogSeed } = await import("../scripts/build-catalog-seed.mjs")

function migratedDatabase() {
  const database = new DatabaseSync(":memory:")
  const migrations = readdirSync(`${repoRoot}migrations`)
    .filter((name) => name.endsWith(".sql"))
    .sort()

  for (const name of migrations) {
    database.exec(readFileSync(`${repoRoot}migrations/${name}`, "utf8"))
  }

  return database
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total
}

test("the committed seed matches a fresh render of the generator", () => {
  assert.equal(
    seedSql,
    renderCatalogSeed(),
    "seed/catalog.sql is stale — run `pnpm seed:build`"
  )
})

test("the seed only ever inserts", () => {
  const forbidden = /\b(DELETE|DROP|TRUNCATE|REPLACE INTO|ALTER)\b/i
  assert.equal(
    forbidden.test(seedSql),
    false,
    "the seed must not contain destructive statements"
  )

  const updates = [...seedSql.matchAll(/^\s*UPDATE\b/gim)]
  assert.equal(updates.length, 0, "the seed must not contain UPDATE statements")

  const tables = new Set(
    [...seedSql.matchAll(/INSERT (?:OR IGNORE )?INTO (\w+)/g)].map(
      (match) => match[1]
    )
  )

  for (const table of tables) {
    assert.ok(
      table.startsWith("catalog_") || table === "system_metadata",
      `the seed writes to an unexpected table: ${table}`
    )
  }
})

test("importing the seed produces the specified dataset", () => {
  const database = migratedDatabase()
  database.exec(readFileSync(`${repoRoot}seed/foundation.sql`, "utf8"))
  database.exec(seedSql)

  assert.equal(count(database, "catalog_products"), 250)
  assert.equal(count(database, "catalog_customers"), 25)
  assert.equal(count(database, "catalog_orders"), 150)

  const contacts = count(database, "catalog_customer_contacts")
  const locations = count(database, "catalog_customer_locations")
  assert.ok(contacts >= 50 && contacts <= 100, `contacts: ${contacts}`)
  assert.ok(locations >= 25 && locations <= 75, `locations: ${locations}`)

  assert.ok(count(database, "catalog_order_lines") >= 150)
  assert.ok(count(database, "catalog_product_aliases") >= 250)
  assert.ok(count(database, "catalog_quantity_breaks") >= 50)
  assert.ok(count(database, "catalog_price_overrides") >= 4)

  const archived = database
    .prepare(
      `SELECT COUNT(*) AS total FROM catalog_products WHERE status = 'archived'`
    )
    .get().total
  assert.ok(archived > 0, "the catalogue needs archived products")

  const contactCounts = database
    .prepare(
      `SELECT COUNT(*) AS total FROM catalog_customer_contacts
        GROUP BY customer_id`
    )
    .all()
    .map((row) => row.total)
  assert.ok(Math.min(...contactCounts) >= 2)
  assert.ok(Math.max(...contactCounts) <= 4)

  const locationCounts = database
    .prepare(
      `SELECT COUNT(*) AS total FROM catalog_customer_locations
        GROUP BY customer_id`
    )
    .all()
    .map((row) => row.total)
  assert.ok(Math.min(...locationCounts) >= 1)
  assert.ok(Math.max(...locationCounts) <= 3)
})

test("reseeding is idempotent and keeps accumulated demo state", () => {
  const database = migratedDatabase()
  database.exec(seedSql)

  // Stand in for anything a live demo accumulates next to the seeded catalogue.
  database.exec(`
    INSERT INTO runs (
      id, view_id, owner_capability_hash, source_kind, scenario_id,
      status, workflow_instance_id, workflow_state, created_at, updated_at
    ) VALUES (
      'run-1', 'view-1', 'hash-1', 'curated', 'messy-forwarded-request',
      'active', NULL, 'accepted', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
    );
  `)
  database.exec(`
    INSERT INTO catalog_product_aliases (sku, alias, alias_kind, customer_id)
    VALUES ('NX-FLT-1120', 'the usual depot filter', 'customer', 'CUST-1001');
  `)

  const before = {
    products: count(database, "catalog_products"),
    aliases: count(database, "catalog_product_aliases"),
    orders: count(database, "catalog_orders"),
  }

  database.exec(seedSql)
  database.exec(seedSql)

  assert.equal(count(database, "catalog_products"), before.products)
  assert.equal(count(database, "catalog_product_aliases"), before.aliases)
  assert.equal(count(database, "catalog_orders"), before.orders)
  assert.equal(count(database, "runs"), 1)

  const learned = database
    .prepare(
      `SELECT COUNT(*) AS total FROM catalog_product_aliases
        WHERE alias = 'the usual depot filter'`
    )
    .get().total
  assert.equal(learned, 1, "reseeding removed accumulated demo data")

  const fingerprint = database
    .prepare(
      `SELECT value FROM system_metadata WHERE key = 'catalog_fingerprint'`
    )
    .get().value
  assert.match(fingerprint, /^[0-9a-f]{8}$/)
})
