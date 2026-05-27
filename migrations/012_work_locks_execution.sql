-- Exclusive work units per worker slot
CREATE TABLE IF NOT EXISTS work_locks (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  lock_kind TEXT NOT NULL,
  lock_key TEXT NOT NULL,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_slot INT NOT NULL DEFAULT 1,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, lock_kind, lock_key)
);

CREATE INDEX IF NOT EXISTS idx_work_locks_job ON work_locks (job_id);

-- Continuous execution state per tenant+project
CREATE TABLE IF NOT EXISTS tenant_execution (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  continuous_active BOOLEAN NOT NULL DEFAULT false,
  pause_after_current BOOLEAN NOT NULL DEFAULT false,
  selected_worker_slots JSONB NOT NULL DEFAULT '[]'::jsonb,
  macro_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_slug)
);

-- Per-slot worker heartbeat (multi-worker)
ALTER TABLE tenant_workers ADD COLUMN IF NOT EXISTS worker_slot INT NOT NULL DEFAULT 1;
ALTER TABLE tenant_workers ADD COLUMN IF NOT EXISTS slots_in_use INT NOT NULL DEFAULT 0;

-- Allow multiple worker rows per tenant (drop old single-tenant unique if exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_workers_tenant_id_key'
  ) THEN
    ALTER TABLE tenant_workers DROP CONSTRAINT tenant_workers_tenant_id_key;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_workers_tenant_slot_key
  ON tenant_workers (tenant_id, worker_slot);

-- develop settings: skip human approval (synced from volume; optional cache)
ALTER TABLE project_develop_settings ADD COLUMN IF NOT EXISTS skip_human_approval BOOLEAN NOT NULL DEFAULT false;
