-- Git managed / migração tardia para repo do cliente
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_migrated_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_managed_repo_full_name TEXT;
