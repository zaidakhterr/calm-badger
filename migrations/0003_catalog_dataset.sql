-- Synthetic distributor dataset: catalogue, customers, and order history.
-- Every row is generated from one fixed seed by `worker/catalog/dataset.ts` and
-- imported through `seed/catalog.sql`, which only ever inserts. Run state
-- (`runs`, `run_steps`) and any accumulated demo feedback live in separate
-- tables that seeding never touches.

CREATE TABLE IF NOT EXISTS catalog_products (
  sku TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  unit TEXT NOT NULL,
  base_price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  replacement_sku TEXT,
  near_duplicate_of TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_products_status_idx
  ON catalog_products (status);

CREATE INDEX IF NOT EXISTS catalog_products_category_idx
  ON catalog_products (category);

-- Aliases carry the messy ways a request can name a product: trade shorthand,
-- typographical variants, superseded item numbers, and wording a single
-- customer keeps using.
CREATE TABLE IF NOT EXISTS catalog_product_aliases (
  sku TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  customer_id TEXT,
  PRIMARY KEY (sku, alias, alias_kind)
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_product_aliases_alias_idx
  ON catalog_product_aliases (alias);

CREATE TABLE IF NOT EXISTS catalog_quantity_breaks (
  sku TEXT NOT NULL,
  min_quantity INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL,
  PRIMARY KEY (sku, min_quantity)
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_customers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  tier TEXT NOT NULL,
  tier_discount_bp INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_customers_domain_idx
  ON catalog_customers (domain);

CREATE TABLE IF NOT EXISTS catalog_customer_contacts (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_customer_contacts_email_idx
  ON catalog_customer_contacts (email);

CREATE INDEX IF NOT EXISTS catalog_customer_contacts_customer_idx
  ON catalog_customer_contacts (customer_id);

CREATE TABLE IF NOT EXISTS catalog_customer_locations (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  label TEXT NOT NULL,
  street TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_customer_locations_customer_idx
  ON catalog_customer_locations (customer_id);

-- Historical, customer-specific prices. An inactive row is a superseded price
-- that must not win over the customer tier or a quantity break.
CREATE TABLE IF NOT EXISTS catalog_price_overrides (
  customer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  active INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (customer_id, sku, effective_from)
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_price_overrides_lookup_idx
  ON catalog_price_overrides (customer_id, sku, active);

CREATE TABLE IF NOT EXISTS catalog_orders (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  ordered_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_orders_customer_idx
  ON catalog_orders (customer_id, ordered_at);

CREATE TABLE IF NOT EXISTS catalog_order_lines (
  order_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  applied_rule TEXT NOT NULL,
  PRIMARY KEY (order_id, position)
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_order_lines_sku_idx
  ON catalog_order_lines (sku);

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '3')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
