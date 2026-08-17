/**
 * Public catalogue browser.
 *
 * These are bounded, read-only projections of the fixed synthetic seed. They
 * deliberately exclude run data, workspace-learned aliases, contact emails,
 * phone numbers, and the full customer address. The largest seeded collection
 * is below the fixed cap, so the client can search the complete result locally
 * without turning free-form input into database queries.
 */

export const CATALOGUE_SECTIONS = [
  "products",
  "customers",
  "orders",
  "aliases",
] as const

export type CatalogueSection = (typeof CATALOGUE_SECTIONS)[number]

const PUBLIC_CATALOGUE_LIMIT = 500

export function isCatalogueSection(value: string): value is CatalogueSection {
  return CATALOGUE_SECTIONS.includes(value as CatalogueSection)
}

export type CatalogueProduct = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  basePriceCents: number
  status: string
  replacementSku: string | null
  nearDuplicateOf: string | null
}

export type CatalogueCustomer = {
  id: string
  name: string
  domain: string
  tier: string
  tierDiscountBp: number
  contactCount: number
  contactNames: string[]
  locationCount: number
  cities: string[]
}

export type CatalogueOrder = {
  id: string
  orderedAt: string
  customerId: string
  customerName: string
  contactName: string
  city: string
  lineCount: number
  totalQuantity: number
  totalCents: number
  skus: string[]
}

export type CatalogueAlias = {
  alias: string
  kind: string
  sku: string
  productName: string
  customerId: string | null
  customerName: string | null
}

export type CatalogueProjection =
  | { section: "products"; rows: CatalogueProduct[] }
  | { section: "customers"; rows: CatalogueCustomer[] }
  | { section: "orders"; rows: CatalogueOrder[] }
  | { section: "aliases"; rows: CatalogueAlias[] }

type ProductRow = {
  sku: string
  name: string
  description: string
  category: string
  manufacturer: string
  unit: string
  base_price_cents: number
  status: string
  replacement_sku: string | null
  near_duplicate_of: string | null
}

type CustomerRow = {
  id: string
  name: string
  domain: string
  tier: string
  tier_discount_bp: number
  contact_count: number
  contact_names: string | null
  location_count: number
  cities: string | null
}

type OrderRow = {
  id: string
  ordered_at: string
  customer_id: string
  customer_name: string
  contact_name: string
  city: string
  line_count: number
  total_quantity: number
  total_cents: number
  skus: string | null
}

type AliasRow = {
  alias: string
  alias_kind: string
  sku: string
  product_name: string
  customer_id: string | null
  customer_name: string | null
}

const PRODUCTS_QUERY = `
  SELECT
    sku,
    name,
    description,
    category,
    manufacturer,
    unit,
    base_price_cents,
    status,
    replacement_sku,
    near_duplicate_of
  FROM catalog_products
  ORDER BY
    CASE status WHEN 'active' THEN 0 ELSE 1 END,
    category,
    name,
    sku
  LIMIT ?
`

const CUSTOMERS_QUERY = `
  SELECT
    c.id,
    c.name,
    c.domain,
    c.tier,
    c.tier_discount_bp,
    (SELECT COUNT(*)
       FROM catalog_customer_contacts contact
      WHERE contact.customer_id = c.id) AS contact_count,
    (SELECT group_concat(contact.name, ' · ')
       FROM catalog_customer_contacts contact
      WHERE contact.customer_id = c.id) AS contact_names,
    (SELECT COUNT(*)
       FROM catalog_customer_locations location
      WHERE location.customer_id = c.id) AS location_count,
    (SELECT group_concat(location.city, ' · ')
       FROM catalog_customer_locations location
      WHERE location.customer_id = c.id) AS cities
  FROM catalog_customers c
  ORDER BY c.name, c.id
  LIMIT ?
`

const ORDERS_QUERY = `
  SELECT
    orders.id,
    orders.ordered_at,
    customers.id AS customer_id,
    customers.name AS customer_name,
    contacts.name AS contact_name,
    locations.city,
    COUNT(lines.position) AS line_count,
    SUM(lines.quantity) AS total_quantity,
    SUM(lines.quantity * lines.unit_price_cents) AS total_cents,
    group_concat(lines.sku, ' · ') AS skus
  FROM catalog_orders orders
  JOIN catalog_customers customers ON customers.id = orders.customer_id
  JOIN catalog_customer_contacts contacts ON contacts.id = orders.contact_id
  JOIN catalog_customer_locations locations ON locations.id = orders.location_id
  JOIN catalog_order_lines lines ON lines.order_id = orders.id
  GROUP BY
    orders.id,
    orders.ordered_at,
    customers.id,
    customers.name,
    contacts.name,
    locations.city
  ORDER BY orders.ordered_at DESC, orders.id DESC
  LIMIT ?
`

const ALIASES_QUERY = `
  SELECT
    aliases.alias,
    aliases.alias_kind,
    aliases.sku,
    products.name AS product_name,
    aliases.customer_id,
    customers.name AS customer_name
  FROM catalog_product_aliases aliases
  JOIN catalog_products products ON products.sku = aliases.sku
  LEFT JOIN catalog_customers customers ON customers.id = aliases.customer_id
  ORDER BY lower(aliases.alias), aliases.sku
  LIMIT ?
`

function splitJoined(value: string | null): string[] {
  return value ? value.split(" · ") : []
}

export async function loadCatalogueProjection(
  env: Env,
  section: CatalogueSection
): Promise<CatalogueProjection> {
  if (section === "products") {
    const result = await env.DB.prepare(PRODUCTS_QUERY)
      .bind(PUBLIC_CATALOGUE_LIMIT)
      .all<ProductRow>()

    return {
      section,
      rows: result.results.map((row) => ({
        sku: row.sku,
        name: row.name,
        description: row.description,
        category: row.category,
        manufacturer: row.manufacturer,
        unit: row.unit,
        basePriceCents: row.base_price_cents,
        status: row.status,
        replacementSku: row.replacement_sku,
        nearDuplicateOf: row.near_duplicate_of,
      })),
    }
  }

  if (section === "customers") {
    const result = await env.DB.prepare(CUSTOMERS_QUERY)
      .bind(PUBLIC_CATALOGUE_LIMIT)
      .all<CustomerRow>()

    return {
      section,
      rows: result.results.map((row) => ({
        id: row.id,
        name: row.name,
        domain: row.domain,
        tier: row.tier,
        tierDiscountBp: row.tier_discount_bp,
        contactCount: row.contact_count,
        contactNames: splitJoined(row.contact_names),
        locationCount: row.location_count,
        cities: splitJoined(row.cities),
      })),
    }
  }

  if (section === "orders") {
    const result = await env.DB.prepare(ORDERS_QUERY)
      .bind(PUBLIC_CATALOGUE_LIMIT)
      .all<OrderRow>()

    return {
      section,
      rows: result.results.map((row) => ({
        id: row.id,
        orderedAt: row.ordered_at,
        customerId: row.customer_id,
        customerName: row.customer_name,
        contactName: row.contact_name,
        city: row.city,
        lineCount: row.line_count,
        totalQuantity: row.total_quantity,
        totalCents: row.total_cents,
        skus: splitJoined(row.skus),
      })),
    }
  }

  const result = await env.DB.prepare(ALIASES_QUERY)
    .bind(PUBLIC_CATALOGUE_LIMIT)
    .all<AliasRow>()

  return {
    section,
    rows: result.results.map((row) => ({
      alias: row.alias,
      kind: row.alias_kind,
      sku: row.sku,
      productName: row.product_name,
      customerId: row.customer_id,
      customerName: row.customer_name,
    })),
  }
}
