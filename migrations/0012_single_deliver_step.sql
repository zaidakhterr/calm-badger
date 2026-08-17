-- Delivery is one step now, `deliver`, and it runs automatically once a run is
-- priced. Older runs carried a second `delivered` node that held the external
-- estimate sentence; fold that sentence into `deliver` where delivery
-- happened, then drop the `delivered` rows so every graph has one terminal
-- node. Positions may keep a gap; the projection orders by position, not by
-- contiguity.

UPDATE run_steps
   SET summary = (
         SELECT d.summary FROM run_steps d
          WHERE d.run_id = run_steps.run_id AND d.step_key = 'delivered'
       ),
       status = 'complete',
       completed_at = COALESCE(
         (
           SELECT d.completed_at FROM run_steps d
            WHERE d.run_id = run_steps.run_id AND d.step_key = 'delivered'
         ),
         completed_at
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE step_key = 'deliver'
   AND EXISTS (
         SELECT 1 FROM run_steps d
          WHERE d.run_id = run_steps.run_id
            AND d.step_key = 'delivered'
            AND d.status = 'complete'
       );

DELETE FROM run_steps WHERE step_key = 'delivered';

INSERT INTO system_metadata (key, value)
VALUES ('schema_version', '12')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
