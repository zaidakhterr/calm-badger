-- Browser-workspace aliases contain wording copied from an RFQ. They therefore
-- inherit the source run's retention deadline instead of receiving a separate
-- thirty-day lifetime. New code writes the exact deadline anchored to the
-- run's creation. Existing aliases have no source-run reference, so expire
-- them immediately rather than guess a later deadline and risk retaining
-- custom-upload text past its source run's twenty-four-hour boundary.

ALTER TABLE workspace_product_aliases ADD COLUMN expires_at TEXT;

UPDATE workspace_product_aliases
   SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_product_aliases_expiry_idx
  ON workspace_product_aliases (expires_at);

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '11')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
