CREATE TABLE IF NOT EXISTS project_agent_overrides (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  role_key TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_slug, role_key),
  FOREIGN KEY (tenant_id, project_slug) REFERENCES projects(tenant_id, slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_agent_overrides_project_idx
  ON project_agent_overrides(tenant_id, project_slug);

-- Copia overrides por tenant para cada projeto existente desse tenant
INSERT INTO project_agent_overrides (tenant_id, project_slug, role_key, content)
SELECT p.tenant_id, p.slug, t.role_key, t.content
FROM tenant_agent_overrides t
INNER JOIN projects p ON p.tenant_id = t.tenant_id
ON CONFLICT (tenant_id, project_slug, role_key) DO NOTHING;
