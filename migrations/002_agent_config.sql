CREATE TABLE IF NOT EXISTS agent_templates (
  role_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS tenant_agent_overrides (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role_key)
);

CREATE INDEX IF NOT EXISTS tenant_agent_overrides_tenant_idx
  ON tenant_agent_overrides(tenant_id);
