-- Deploy do worker CLI no Railway (1 serviço por tenant)
CREATE TABLE IF NOT EXISTS tenant_worker_deployments (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'deployed', 'failed')),
  railway_service_id TEXT,
  railway_volume_id TEXT,
  last_error TEXT,
  provisioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_worker_deployments_status_idx
  ON tenant_worker_deployments(status);
