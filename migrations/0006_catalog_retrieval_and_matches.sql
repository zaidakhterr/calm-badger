-- Bounded catalogue matching: a full-text index over the complete active
-- catalogue, the candidates each requested line retrieved, and the product
-- decision each line reached.
--
-- The index is a plain FTS5 table rather than an external-content one because
-- seeding is additive and may run more than once: `worker/catalog/retrieval.ts`
-- compares a cheap signature of the catalogue against `catalog_search_state`
-- and rebuilds the whole index deterministically when they disagree. Nothing
-- here is destructive to seeded data, and the index can always be thrown away
-- and rebuilt from `catalog_products` and `catalog_product_aliases`.

CREATE VIRTUAL TABLE IF NOT EXISTS catalog_search USING fts5(
  sku UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- The same aliases, normalised exactly the way a request phrase is normalised,
-- so an exact alias match is one indexed equality lookup rather than a scan
-- with SQL string surgery. Rebuilt from `catalog_product_aliases` by the same
-- signature check as the full-text index.
CREATE TABLE IF NOT EXISTS catalog_alias_lookup (
  normalised TEXT NOT NULL,
  sku TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  customer_id TEXT,
  PRIMARY KEY (normalised, sku, alias_kind)
) STRICT;

CREATE INDEX IF NOT EXISTS catalog_alias_lookup_normalised_idx
  ON catalog_alias_lookup (normalised);

CREATE TABLE IF NOT EXISTS catalog_search_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  -- Cheap catalogue fingerprint. A change means the index is rebuilt.
  signature TEXT NOT NULL,
  indexed_products INTEGER NOT NULL,
  built_at TEXT NOT NULL
) STRICT;

-- What retrieval found for one requested line, before any model judgement.
-- `source` records why a product was considered at all, which is what makes the
-- difference between deterministic evidence and a retrieved guess inspectable.
CREATE TABLE IF NOT EXISTS run_line_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  sku TEXT NOT NULL,
  -- 'exact_sku' | 'known_alias' | 'customer_alias' | 'typo_alias' |
  -- 'legacy_alias' | 'archived_successor' | 'full_text'
  source TEXT NOT NULL,
  rank INTEGER NOT NULL,
  -- Retrieval score. Comparable within one line only; never a probability.
  score REAL NOT NULL,
  -- 1 when the candidate was part of the bounded shortlist sent onwards.
  shortlisted INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, position, sku)
) STRICT;

CREATE INDEX IF NOT EXISTS run_line_candidates_run_idx
  ON run_line_candidates (run_id, position, rank);

-- The product decision for one requested line. A row here never carries a SKU
-- that failed the integrity check, and never an archived product, so pricing
-- can treat `sku` on an accepted row as canonical. On a review row the same
-- column holds the proposal a reviewer is being asked about, which is why only
-- `state = 'accepted'` may ever be priced.
CREATE TABLE IF NOT EXISTS run_line_matches (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- 'accepted' | 'review_required'
  state TEXT NOT NULL,
  sku TEXT,
  -- 'exact_sku' | 'known_alias' | 'rerank' | 'none'
  method TEXT NOT NULL,
  -- 'High' | 'Medium' | 'Review'. A demo heuristic, not calibrated certainty.
  confidence_label TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  -- Distance to the runner-up, which is half of the acceptance heuristic.
  winner_gap REAL NOT NULL,
  reason TEXT NOT NULL,
  -- JSON array of the top-three alternatives with their scores and reasons.
  alternatives TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, position)
) STRICT;

CREATE INDEX IF NOT EXISTS run_line_matches_run_idx
  ON run_line_matches (run_id, position);

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '6')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
