-- The owner review node, and the only learning this demo keeps.
--
-- `run_reviews` is the run's single human-in-the-loop gate. Customer, quantity,
-- extracted-field, and product uncertainty all consolidate into one row here
-- with one `state`, because the workflow stops in exactly one place. That state
-- is the authority the durable workflow resumes on: the review event carries no
-- decision of its own, and a conditional update out of `pending` is what makes
-- a repeated, premature, or racing decision a no-op rather than a second
-- progression.
--
-- `run_review_items` is what the owner is actually asked. One row per decision,
-- each carrying the phrase the request used, the proposal, the confidence
-- heuristic, the reasons, and the top three catalogue alternatives — the same
-- evidence a shared viewer may read, minus any control to change it. The
-- resolved columns record what the owner chose, so an approved run can be
-- replayed and explained rather than merely priced.
--
-- `workspace_product_aliases` is the learning boundary. An approved correction
-- becomes wording *this browser's workspace* records for *that customer*, and
-- nothing else: the seeded `catalog_product_aliases` is never written to, so no
-- correction can reach the global demo dataset or another visitor's run. The
-- workspace is an anonymous token held in the owner's browser; only its hash is
-- stored here and on the run, exactly like the owner capability. Retrieval
-- consults this table only for a run carrying the same workspace hash.
--
-- Learned aliases deliberately outlive `Start over`: they are workspace memory
-- rather than run artifacts, which is what lets a later run in the same browser
-- benefit from an earlier correction. They carry no run reference for that
-- reason, and `created_at` is what a retention sweep can prune them by.

ALTER TABLE runs ADD COLUMN workspace_hash TEXT;

CREATE INDEX IF NOT EXISTS runs_workspace_idx ON runs (workspace_hash);

CREATE TABLE IF NOT EXISTS run_reviews (
  run_id TEXT PRIMARY KEY NOT NULL,
  -- 'pending' | 'approved' | 'rejected' | 'expired'. Only one transition out
  -- of 'pending' ever succeeds.
  state TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  -- After this instant the review can no longer be decided. The window mirrors
  -- the run's own retention: a review must not outlive the data it decides.
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  summary TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS run_review_items (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  -- 'customer' | 'product' | 'quantity' | 'field'
  kind TEXT NOT NULL,
  -- The requested line this decision belongs to; -1 for the run-level customer.
  position INTEGER NOT NULL,
  -- The request's own words, so the decision is anchored in the source.
  source_phrase TEXT NOT NULL,
  detail TEXT NOT NULL,
  proposed_label TEXT NOT NULL,
  proposed_sku TEXT,
  proposed_quantity INTEGER,
  proposed_customer_id TEXT,
  -- 'High' | 'Medium' | 'Review'. A demo heuristic, not calibrated certainty.
  confidence_label TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  heuristic TEXT NOT NULL,
  -- JSON array of short reasons this decision needs a human.
  reasons TEXT NOT NULL,
  -- JSON array of at most three alternatives with their evidence.
  alternatives TEXT NOT NULL,
  -- 'pending' | 'resolved'
  state TEXT NOT NULL,
  -- 'accepted_proposal' | 'chose_alternative' | 'chose_catalog' |
  -- 'corrected_quantity' | 'selected_customer' | 'confirmed_extraction'
  decision TEXT,
  resolved_sku TEXT,
  resolved_quantity INTEGER,
  resolved_customer_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, kind, position)
) STRICT;

CREATE INDEX IF NOT EXISTS run_review_items_run_idx
  ON run_review_items (run_id, position);

CREATE TABLE IF NOT EXISTS workspace_product_aliases (
  -- SHA-256 of the anonymous workspace token. The token itself is never stored.
  workspace_hash TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  -- The phrase normalised exactly as `worker/catalog/retrieval.ts` normalises a
  -- request phrase, so a later lookup is one indexed equality.
  normalised TEXT NOT NULL,
  alias TEXT NOT NULL,
  sku TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, customer_id, normalised, sku)
) STRICT;

CREATE INDEX IF NOT EXISTS workspace_product_aliases_lookup_idx
  ON workspace_product_aliases (workspace_hash, customer_id, normalised);

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '9')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
