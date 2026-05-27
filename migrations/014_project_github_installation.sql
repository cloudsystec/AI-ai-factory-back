-- Per-project GitHub installation (previously per-tenant only)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_installation_id BIGINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_account_login TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_connected_at TIMESTAMPTZ;
