-- Persisted RFQ runs and their business workflow steps.
-- A run is addressed publicly by an unguessable view_id. Owner authority is a
-- separate 32-byte capability; only its SHA-256 hash is stored here.

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY NOT NULL,
  view_id TEXT NOT NULL UNIQUE,
  owner_capability_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  scenario_id TEXT,
  status TEXT NOT NULL,
  workflow_instance_id TEXT,
  workflow_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, step_key)
) STRICT;

CREATE INDEX IF NOT EXISTS run_steps_run_position_idx
  ON run_steps (run_id, position);

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '2')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
