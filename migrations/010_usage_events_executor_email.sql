ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS executor_email TEXT;

UPDATE usage_events ue
SET executor_email = u.email
FROM jobs j
JOIN users u ON u.id = j.requested_by_user_id
WHERE ue.job_id = j.id AND ue.executor_email IS NULL;
