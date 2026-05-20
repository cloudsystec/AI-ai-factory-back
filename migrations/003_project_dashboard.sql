ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payload JSONB;

CREATE TABLE IF NOT EXISTS project_develop_settings (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  autorun BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_slug)
);

CREATE TABLE IF NOT EXISTS project_dashboard_snapshots (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  tasks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope_state_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_slug)
);

CREATE TABLE IF NOT EXISTS project_task_details (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  task_id TEXT NOT NULL,
  detail_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_slug, task_id)
);
