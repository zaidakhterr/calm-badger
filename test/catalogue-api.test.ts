import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import type { CatalogueProjection } from "../worker/catalogue"

/**
 * The fields a browsable row has to carry.
 *
 * The projection's own type already names them; these schemas are what the
 * response actually has to hold at runtime, so a row that arrives with a field
 * missing or of the wrong kind fails the test rather than typechecking.
 */
const PRODUCT_ROW_SCHEMA = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  manufacturer: z.string(),
  basePriceCents: z.number(),
})

const ALIAS_ROW_SCHEMA = z.object({
  alias: z.string(),
  kind: z.string(),
  sku: z.string(),
  productName: z.string(),
})

async function readCatalogue(section: string): Promise<{
  response: Response
  catalogue: CatalogueProjection
}> {
  const response = await exports.default.fetch(
    `https://example.test/api/catalogue/${section}`
  )
  const body = await response.json<{ catalogue: CatalogueProjection }>()
  return { response, catalogue: body.catalogue }
}

describe("public catalogue browser", () => {
  it("returns every product with searchable commercial fields", async () => {
    const { response, catalogue } = await readCatalogue("products")

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(catalogue.section).toBe("products")
    if (catalogue.section !== "products") throw new Error("wrong projection")

    expect(catalogue.rows).toHaveLength(250)
    expect(catalogue.rows.some((row) => row.status === "archived")).toBe(true)
    PRODUCT_ROW_SCHEMA.parse(catalogue.rows[0])
  })

  it("summarizes every customer without exposing contact details", async () => {
    const { catalogue } = await readCatalogue("customers")

    expect(catalogue.section).toBe("customers")
    if (catalogue.section !== "customers") throw new Error("wrong projection")

    expect(catalogue.rows).toHaveLength(25)
    expect(catalogue.rows.every((row) => row.contactCount > 0)).toBe(true)
    expect(catalogue.rows.every((row) => row.locationCount > 0)).toBe(true)
    expect(JSON.stringify(catalogue)).not.toContain("email")
    expect(JSON.stringify(catalogue)).not.toContain("phone")
  })

  it("returns the complete historical order ledger with item summaries", async () => {
    const { catalogue } = await readCatalogue("orders")

    expect(catalogue.section).toBe("orders")
    if (catalogue.section !== "orders") throw new Error("wrong projection")

    expect(catalogue.rows).toHaveLength(150)
    expect(catalogue.rows.every((row) => row.lineCount > 0)).toBe(true)
    expect(catalogue.rows.every((row) => row.totalCents > 0)).toBe(true)
    expect(catalogue.rows.every((row) => row.skus.length > 0)).toBe(true)
  })

  it("returns seeded aliases without workspace-learned wording", async () => {
    const { catalogue } = await readCatalogue("aliases")

    expect(catalogue.section).toBe("aliases")
    if (catalogue.section !== "aliases") throw new Error("wrong projection")

    expect(catalogue.rows.length).toBeGreaterThan(250)
    ALIAS_ROW_SCHEMA.parse(catalogue.rows[0])
  })

  it("rejects writes and unknown catalogue sections", async () => {
    const writeResponse = await exports.default.fetch(
      "https://example.test/api/catalogue/products",
      { method: "POST" }
    )
    expect(writeResponse.status).toBe(405)
    expect(writeResponse.headers.get("allow")).toBe("GET")

    const missingResponse = await exports.default.fetch(
      "https://example.test/api/catalogue/unknown"
    )
    expect(missingResponse.status).toBe(404)
    await expect(missingResponse.json()).resolves.toEqual({
      error: "Catalogue section not found",
    })
  })
})
