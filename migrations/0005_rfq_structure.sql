-- Validated RFQ facts and the customer the run resolved to.
-- Nothing reaches these tables until model output has survived one JSON-repair
-- attempt, the Zod schema, and business validation, so a later step can treat
-- every row here as canonical. A line the business rules rejected is still
-- recorded, but carries an explicit review state and never a usable quantity or
-- catalogue reference.

CREATE TABLE IF NOT EXISTS run_rfq (
  run_id TEXT PRIMARY KEY NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  delivery_location TEXT,
  -- 'email' | 'pdf' | 'image' | 'mixed'
  source_channel TEXT NOT NULL,
  source_subject TEXT,
  source_received_at TEXT,
  -- JSON array of the document references the request quoted.
  source_references TEXT NOT NULL,
  deadline_date TEXT,
  deadline_text TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS run_rfq_line_items (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- The product reference exactly as the request wrote it.
  reference TEXT NOT NULL,
  description TEXT NOT NULL,
  -- NULL whenever the extracted quantity failed business validation.
  quantity INTEGER,
  unit TEXT,
  -- Only ever a SKU that exists in catalog_products.
  catalog_sku TEXT,
  source_label TEXT NOT NULL,
  source_page INTEGER,
  -- 'accepted' | 'review_required'
  validation_state TEXT NOT NULL,
  validation_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, position)
) STRICT;

CREATE INDEX IF NOT EXISTS run_rfq_line_items_run_idx
  ON run_rfq_line_items (run_id, position);

CREATE TABLE IF NOT EXISTS run_customer_resolution (
  run_id TEXT PRIMARY KEY NOT NULL,
  -- 'resolved' | 'unresolved'. A run is never allowed to create a customer.
  state TEXT NOT NULL,
  customer_id TEXT,
  contact_id TEXT,
  location_id TEXT,
  -- 'High' | 'Medium' | 'Review'. A demo heuristic, not calibrated certainty.
  confidence_label TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '5')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
