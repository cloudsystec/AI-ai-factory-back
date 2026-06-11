CREATE TABLE IF NOT EXISTS project_discovery_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'ready', 'consumed')),
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  decisions JSONB NOT NULL DEFAULT '{}'::jsonb,
  open_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_name TEXT,
  proposed_slug TEXT,
  scope_md TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS project_discovery_sessions_tenant_user_idx
  ON project_discovery_sessions (tenant_id, user_id, status);

CREATE INDEX IF NOT EXISTS project_discovery_sessions_expires_idx
  ON project_discovery_sessions (expires_at);
