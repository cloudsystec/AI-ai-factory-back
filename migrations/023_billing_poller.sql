ALTER TABLE billing_ai_calls
  ADD COLUMN IF NOT EXISTS cursor_matched_event_ms BIGINT NULL;

ALTER TABLE billing_ai_calls
  DROP COLUMN IF EXISTS cursor_event_count;

CREATE INDEX IF NOT EXISTS billing_ai_calls_awaiting_settle_idx
  ON billing_ai_calls (tenant_id, ended_at)
  WHERE status IN ('pending', 'estimated')
    AND source IS DISTINCT FROM 'cursor_admin_api';
