-- Running a funded public demo without a login: bounded processing, bounded
-- retention, and enough metadata to tell whether a cleanup finished.
--
-- `rate_limit_windows` is the only place a visitor is counted, and it holds no
-- address. The key is SHA-256 over the rotating secret, the purpose, the fixed
-- hour the request fell in, and the client address, so the same visitor is a
-- different, unlinkable key every hour and no stable per-IP identifier ever
-- accumulates. A row is a counter with an end instant; the daily sweep drops
-- rows whose hour has passed, so the table cannot grow without bound either.
--
-- The three purge columns on `runs` exist for one reason: a cleanup deletes R2
-- objects before it cascades D1, and those two steps cannot be one
-- transaction. `purge_started_at` is written before the first delete, so a run
-- that still exists with that column set is a cleanup that did not finish. The
-- next sweep picks exactly those rows up first, `purge_attempts` says how often
-- it has tried, and `purge_error` carries the failure *name* only — never a
-- message, a key, or any run content.
--
-- `retention_sweeps` is the operator's view of the job itself: what each run of
-- the cron scanned, purged, failed, and pruned. Counts only; no identifiers of
-- what was deleted, because the point of deleting it was that it stops
-- existing.

ALTER TABLE runs ADD COLUMN purge_started_at TEXT;
ALTER TABLE runs ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN purge_error TEXT;

CREATE INDEX IF NOT EXISTS runs_retention_idx ON runs (created_at);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  -- SHA-256 of (rotating secret, purpose, hour bucket, client address). The
  -- address itself is never written here or anywhere else.
  bucket_hash TEXT PRIMARY KEY NOT NULL,
  -- The fixed hour this counter belongs to, as ISO-8601 instants.
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  hits INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS rate_limit_windows_end_idx
  ON rate_limit_windows (window_end);

CREATE TABLE IF NOT EXISTS retention_sweeps (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  -- 'scheduled' | 'manual'. Not named `trigger`: that is a SQL keyword.
  trigger_kind TEXT NOT NULL,
  runs_scanned INTEGER NOT NULL,
  runs_purged INTEGER NOT NULL,
  runs_failed INTEGER NOT NULL,
  runs_deferred INTEGER NOT NULL,
  aliases_pruned INTEGER NOT NULL,
  rate_windows_pruned INTEGER NOT NULL,
  -- 1 when the batch limit was reached and more work remains for the next
  -- schedule. A sweep is deliberately bounded rather than exhaustive.
  more_pending INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS retention_sweeps_started_idx
  ON retention_sweeps (started_at);

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '10')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
