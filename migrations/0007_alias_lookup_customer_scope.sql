-- Widen the alias keys so one customer's private wording cannot displace
-- another's.
--
-- Both alias tables left the customer out of their key. `catalog_product_aliases`
-- was keyed on (sku, alias, alias_kind), so the second customer to record a
-- phrase for a product was dropped by the seed's `INSERT OR IGNORE`, and
-- `catalog_alias_lookup` was keyed on (normalised, sku, alias_kind), which left
-- the customer out. Two customers correcting the same phrase to the same
-- product collapsed into one row: the second `INSERT OR REPLACE` overwrote the
-- first, and whichever customer was written last owned that phrase for
-- everybody. Ticket 09 writes customer-specific aliases from approved
-- corrections, so the key has to include the customer before that happens.
--
-- The customer column has to stay nullable, because a catalogue-wide alias
-- belongs to no customer and retrieval reads that NULL directly. A STRICT
-- table gives every PRIMARY KEY column an implicit NOT NULL, so the key is a
-- unique index over COALESCE(customer_id, '') instead: NULL then behaves as one
-- shared "catalogue-wide" key rather than as a distinct value per row.
--
-- Both tables are rebuilt beside their originals and renamed into place, since
-- SQLite cannot alter a key in place. Every existing row is copied first, so
-- this is additive: no seeded alias is lost, and reseeding stays an idempotent
-- `INSERT OR IGNORE` against the widened key. `catalog_alias_lookup` is only a
-- derived index — `worker/catalog/retrieval.ts` rebuilds it from
-- `catalog_product_aliases` whenever the catalogue signature disagrees with
-- `catalog_search_state` — so the recorded signature is cleared here and the
-- next retrieval rebuilds it deterministically, restoring rows the old key
-- merged.

CREATE TABLE IF NOT EXISTS catalog_product_aliases_v2 (
  sku TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  -- NULL for a catalogue-wide alias; a customer id for private wording.
  customer_id TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS catalog_product_aliases_v2_key_idx
  ON catalog_product_aliases_v2 (sku, alias, alias_kind, COALESCE(customer_id, ''));

INSERT OR IGNORE INTO catalog_product_aliases_v2
  (sku, alias, alias_kind, customer_id)
SELECT sku, alias, alias_kind, customer_id FROM catalog_product_aliases;

DROP TABLE catalog_product_aliases;

ALTER TABLE catalog_product_aliases_v2 RENAME TO catalog_product_aliases;

CREATE INDEX IF NOT EXISTS catalog_product_aliases_alias_idx
  ON catalog_product_aliases (alias);

CREATE TABLE IF NOT EXISTS catalog_alias_lookup_v2 (
  normalised TEXT NOT NULL,
  sku TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  -- NULL for a catalogue-wide alias; a customer id for private wording.
  customer_id TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS catalog_alias_lookup_v2_key_idx
  ON catalog_alias_lookup_v2 (
    normalised, sku, alias_kind, COALESCE(customer_id, '')
  );

INSERT OR IGNORE INTO catalog_alias_lookup_v2
  (normalised, sku, alias, alias_kind, customer_id)
SELECT normalised, sku, alias, alias_kind, customer_id
  FROM catalog_alias_lookup;

DROP TABLE catalog_alias_lookup;

ALTER TABLE catalog_alias_lookup_v2 RENAME TO catalog_alias_lookup;

CREATE INDEX IF NOT EXISTS catalog_alias_lookup_normalised_idx
  ON catalog_alias_lookup (normalised);

-- Forget the recorded fingerprint so the next retrieval rebuilds the alias and
-- full-text indexes from the catalogue.
DELETE FROM catalog_search_state;

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '7')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
