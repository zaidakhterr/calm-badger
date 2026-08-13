INSERT INTO system_metadata (key, value)
VALUES ('seed_state', 'foundation-ready')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
