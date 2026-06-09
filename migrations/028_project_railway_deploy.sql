-- Deploy Railway pós-conclusão (repo deploy privado)

CREATE TABLE IF NOT EXISTS project_railway_deployments (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  deploy_repo_full_name TEXT,
  deploy_branch TEXT NOT NULL DEFAULT 'main',
  topology TEXT,
  verdict TEXT,
  blockers JSONB,
  railway_project_id TEXT,
  railway_environment_id TEXT,
  railway_services JSONB NOT NULL DEFAULT '[]'::jsonb,
  public_url TEXT,
  last_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  last_error TEXT,
  deployed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_slug),
  CONSTRAINT project_railway_deployments_status_check CHECK (
    status IN (
      'idle',
      'analyzing',
      'syncing',
      'provisioning',
      'verifying',
      'deployed',
      'failed',
      'not_deployable'
    )
  )
);

CREATE INDEX IF NOT EXISTS project_railway_deployments_status_idx
  ON project_railway_deployments (tenant_id, status);
