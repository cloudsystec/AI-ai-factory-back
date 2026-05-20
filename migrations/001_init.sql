CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL DEFAULT 'starter',
  plan_active_until TIMESTAMPTZ NOT NULL,
  balance_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  pool_credit_cycle_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  agent_slots_max INT NOT NULL DEFAULT 1,
  agent_slots_in_use INT NOT NULL DEFAULT 0,
  has_active_job BOOLEAN NOT NULL DEFAULT false,
  cursor_api_key_encrypted TEXT,
  worker_status TEXT NOT NULL DEFAULT 'offline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  macro_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  exit_code INT,
  worker_id TEXT,
  cost_base_usd NUMERIC(12, 4),
  charge_usd NUMERIC(12, 4),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_tenant_status_idx ON jobs(tenant_id, status);

CREATE TABLE IF NOT EXISTS job_log_lines (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  line TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_log_lines_job_idx ON job_log_lines(job_id, id);

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE,
  job_id UUID REFERENCES jobs(id),
  cost_base_usd NUMERIC(12, 4) NOT NULL,
  charge_usd NUMERIC(12, 4) NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_workers (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  worker_id TEXT,
  last_heartbeat TIMESTAMPTZ,
  slots_in_use INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
