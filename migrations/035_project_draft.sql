-- Liga sessões de descoberta a projetos draft criados na 1ª mensagem humana do chat.
-- projects.status passa a aceitar 'draft' (além de 'active' e 'completed').

ALTER TABLE project_discovery_sessions
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS project_discovery_sessions_project_id_idx
  ON project_discovery_sessions (project_id)
  WHERE status != 'consumed';
