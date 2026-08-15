#!/usr/bin/env node

/**
 * Makes the remote deterministic catalogue a deployment precondition.
 *
 * A completely empty catalogue is the expected state of a freshly migrated
 * database, so it is safe to import the two idempotent seed files there. Any
 * other state below the deterministic baseline is ambiguous: silently adding
 * rows could hide a failed or partial import. That state stops deployment and
 * requires an operator to inspect it instead.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

export const CATALOG_MINIMUMS = Object.freeze({
  products: 250,
  customers: 25,
})

const COUNT_SQL = `SELECT
  (SELECT COUNT(*) FROM catalog_products) AS products,
  (SELECT COUNT(*) FROM catalog_customers) AS customers;`

const COUNT_ARGS = [
  "d1",
  "execute",
  "DB",
  "--remote",
  "--command",
  COUNT_SQL,
  "--json",
]

const FOUNDATION_SEED_ARGS = [
  "d1",
  "execute",
  "DB",
  "--remote",
  "--file",
  "./seed/foundation.sql",
]

const CATALOG_SEED_ARGS = [
  "d1",
  "execute",
  "DB",
  "--remote",
  "--file",
  "./seed/catalog.sql",
]

/** Returns `seed` only for a truly empty catalogue, or `ready` above baseline. */
export function catalogAction(counts) {
  validateCounts(counts)

  if (counts.products === 0 && counts.customers === 0) return "seed"

  assertMinimums(counts, "Remote catalogue")
  return "ready"
}

/** Parses the one-row JSON envelope emitted by `wrangler d1 execute --json`. */
export function parseCatalogCounts(output) {
  let payload

  try {
    payload = JSON.parse(output)
  } catch {
    throw new Error(
      "Wrangler returned unreadable JSON while counting the catalogue"
    )
  }

  const execution = Array.isArray(payload) ? payload[0] : payload
  const row = execution?.results?.[0]

  if (execution?.success !== true || !row) {
    throw new Error("Wrangler returned no successful catalogue count")
  }

  return {
    products: readCount(row.products, "products"),
    customers: readCount(row.customers, "customers"),
  }
}

/**
 * Queries, conditionally seeds, and verifies. `runWrangler` is injectable so
 * tests exercise every branch without credentials or remote writes.
 */
export async function ensureRemoteCatalog({
  runWrangler = runWranglerCommand,
  log = console.log,
} = {}) {
  const before = await remoteCounts(runWrangler)
  const action = catalogAction(before)

  log(`Remote catalogue: ${describeCounts(before)}.`)

  if (action === "ready") {
    log("Catalogue meets the deterministic baseline; no seed was imported.")
    return { seeded: false, counts: before }
  }

  log(
    "Catalogue is empty; importing the idempotent foundation and catalogue seeds."
  )
  await runWrangler(FOUNDATION_SEED_ARGS)
  await runWrangler(CATALOG_SEED_ARGS)

  const after = await remoteCounts(runWrangler)
  assertMinimums(after, "Remote catalogue after seeding")

  log(`Catalogue seed verified: ${describeCounts(after)}.`)
  return { seeded: true, counts: after }
}

async function remoteCounts(runWrangler) {
  return parseCatalogCounts(await runWrangler(COUNT_ARGS))
}

function validateCounts(counts) {
  readCount(counts?.products, "products")
  readCount(counts?.customers, "customers")
}

function assertMinimums(counts, label) {
  validateCounts(counts)

  if (
    counts.products < CATALOG_MINIMUMS.products ||
    counts.customers < CATALOG_MINIMUMS.customers
  ) {
    throw new Error(
      `${label} is partially populated (${describeCounts(counts)}); expected at least ` +
        `${CATALOG_MINIMUMS.products} products and ${CATALOG_MINIMUMS.customers} customers. ` +
        "Deployment stopped without importing seed data. Inspect the database before repairing it."
    )
  }
}

function readCount(value, label) {
  const count = typeof value === "string" ? Number(value) : value

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Wrangler returned an invalid ${label} count`)
  }

  return count
}

function describeCounts(counts) {
  return `${counts.products} products, ${counts.customers} customers`
}

async function runWranglerCommand(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000,
  })

  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)

    const detail = result.error ? `: ${result.error.message}` : ""
    throw new Error(`Wrangler D1 command failed${detail}`)
  }

  return result.stdout
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null

if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await ensureRemoteCatalog()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
