-- The priced result of a run and its simulated external delivery.
--
-- `run_quotes` holds the canonical, provider-neutral quote exactly as it was
-- built: the same document the interface renders, a reviewer downloads, and an
-- adapter transforms. The amounts are stored as integer cents beside it so the
-- graph and the totals can be read without parsing the document. There is one
-- quote per run, rebuilt in place if pricing runs again.
--
-- `run_deliveries` holds one simulated delivery per run: which adapter was
-- chosen, the payload that adapter produced, and the synthetic identifier it
-- returned. Nothing here was sent anywhere. Both tables are run state, never
-- catalogue data, so seeding never touches them and `deleteRun` removes them.

CREATE TABLE IF NOT EXISTS run_quotes (
  run_id TEXT PRIMARY KEY NOT NULL,
  quote_number TEXT NOT NULL,
  currency TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  -- Integer cents. No amount in this application is ever a floating euro.
  subtotal_cents INTEGER NOT NULL,
  vat_rate_bp INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  -- The canonical quote as JSON. Allowlisted at assembly: no storage key,
  -- capability, prompt, or provider response ever enters it.
  document TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS run_deliveries (
  run_id TEXT PRIMARY KEY NOT NULL,
  -- 'corebridge-sandbox' | 'generic-erp-webhook'. Both are simulated locally.
  adapter TEXT NOT NULL,
  -- Synthetic, deterministic, and not an identifier in any real system.
  external_estimate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  receipt TEXT NOT NULL,
  delivered_at TEXT NOT NULL
) STRICT;

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '8')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
