-- Original RFQ sources and the document text read from them.
-- Source bytes live in private R2; only the object key, provenance, and the
-- extracted page text are stored here. Step evidence is a sanitized JSON
-- payload per workflow step; it never contains credentials or request headers.

CREATE TABLE IF NOT EXISTS run_sources (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- 'email_body' | 'inline_image' | 'attachment'
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, position)
) STRICT;

CREATE INDEX IF NOT EXISTS run_sources_run_idx ON run_sources (run_id, position);

CREATE TABLE IF NOT EXISTS run_source_pages (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  dpi INTEGER,
  -- JSON array of image regions detected on the page, without image bytes.
  regions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, page_number)
) STRICT;

CREATE INDEX IF NOT EXISTS run_source_pages_run_idx
  ON run_source_pages (run_id, source_id, page_number);

CREATE TABLE IF NOT EXISTS run_step_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, step_key, kind)
) STRICT;

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '4')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
