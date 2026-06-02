CREATE TABLE IF NOT EXISTS billing_ai_calls (
  id                  TEXT PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_file          TEXT,
  agent_name          TEXT,
  meta                JSONB NOT NULL DEFAULT '{}',
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'settled', 'estimated')),
  cost_base_usd       NUMERIC(12, 6) NOT NULL DEFAULT 0,
  source              TEXT,
  cursor_event_count  INT NOT NULL DEFAULT 0,
  match_delta_ms      INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_ai_calls_job_idx
  ON billing_ai_calls (job_id);

CREATE INDEX IF NOT EXISTS billing_ai_calls_tenant_started_idx
  ON billing_ai_calls (tenant_id, started_at);

CREATE TABLE IF NOT EXISTS billing_cursor_event_claims (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_email           TEXT NOT NULL,
  cursor_event_key    TEXT NOT NULL,
  event_timestamp_ms  BIGINT NOT NULL,
  charged_cents       INT NOT NULL DEFAULT 0,
  job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  call_id             TEXT NOT NULL REFERENCES billing_ai_calls(id) ON DELETE CASCADE,
  claimed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bot_email, cursor_event_key)
);

CREATE INDEX IF NOT EXISTS billing_cursor_claims_bot_time_idx
  ON billing_cursor_event_claims (tenant_id, bot_email, event_timestamp_ms);

CREATE INDEX IF NOT EXISTS billing_cursor_claims_job_idx
  ON billing_cursor_event_claims (job_id);
