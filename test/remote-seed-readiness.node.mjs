import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CATALOG_MINIMUMS,
  catalogAction,
  ensureRemoteCatalog,
  parseCatalogCounts,
} from "../scripts/seed-remote-if-empty.mjs"

const countResult = (products, customers) =>
  JSON.stringify([
    {
      results: [{ products, customers }],
      success: true,
    },
  ])

test("only a completely empty catalogue may be seeded", () => {
  assert.equal(catalogAction({ products: 0, customers: 0 }), "seed")
  assert.equal(catalogAction(CATALOG_MINIMUMS), "ready")
  assert.equal(catalogAction({ products: 275, customers: 30 }), "ready")

  assert.throws(
    () => catalogAction({ products: 250, customers: 0 }),
    /partially populated/
  )
  assert.throws(
    () => catalogAction({ products: 249, customers: 25 }),
    /expected at least 250 products and 25 customers/
  )
  assert.throws(
    () => catalogAction({ products: 250, customers: 24 }),
    /expected at least 250 products and 25 customers/
  )
})

test("Wrangler catalogue counts are parsed and validated", () => {
  assert.deepEqual(parseCatalogCounts(countResult("250", 25)), {
    products: 250,
    customers: 25,
  })

  assert.throws(() => parseCatalogCounts("not JSON"), /unreadable JSON/)
  assert.throws(
    () => parseCatalogCounts(JSON.stringify([{ success: false }])),
    /no successful catalogue count/
  )
  assert.throws(
    () => parseCatalogCounts(countResult(-1, 25)),
    /invalid products count/
  )
})

test("an empty remote catalogue is seeded and verified", async () => {
  const calls = []
  const responses = [
    countResult(0, 0),
    "foundation imported",
    "catalogue imported",
    countResult(250, 25),
  ]

  const result = await ensureRemoteCatalog({
    runWrangler: async (args) => {
      calls.push(args)
      return responses.shift()
    },
    log() {},
  })

  assert.deepEqual(result, {
    seeded: true,
    counts: { products: 250, customers: 25 },
  })
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[1].slice(-2), ["--file", "./seed/foundation.sql"])
  assert.deepEqual(calls[2].slice(-2), ["--file", "./seed/catalog.sql"])
})

test("a ready remote catalogue is verified without writes", async () => {
  const calls = []

  const result = await ensureRemoteCatalog({
    runWrangler: async (args) => {
      calls.push(args)
      return countResult(250, 25)
    },
    log() {},
  })

  assert.deepEqual(result, {
    seeded: false,
    counts: { products: 250, customers: 25 },
  })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes("--command"))
})

test("partial state fails before any seed is imported", async () => {
  const calls = []

  await assert.rejects(
    ensureRemoteCatalog({
      runWrangler: async (args) => {
        calls.push(args)
        return countResult(250, 12)
      },
      log() {},
    }),
    /Deployment stopped without importing seed data/
  )

  assert.equal(calls.length, 1)
})

test("an incomplete import fails final verification", async () => {
  const responses = [
    countResult(0, 0),
    "foundation imported",
    "catalogue imported",
    countResult(249, 25),
  ]

  await assert.rejects(
    ensureRemoteCatalog({
      runWrangler: async () => responses.shift(),
      log() {},
    }),
    /Remote catalogue after seeding is partially populated/
  )
})
