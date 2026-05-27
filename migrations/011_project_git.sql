-- GitHub App per tenant
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS github_installation_id BIGINT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS github_account_login TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS github_connected_at TIMESTAMPTZ;

-- Git per project
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo_full_name TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_default_branch TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_tech_lead_branch TEXT NOT NULL DEFAULT 'tech-lead';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo_mode TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS git_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS git_last_error TEXT;

-- Task PRs + TL review
CREATE TABLE IF NOT EXISTS task_pull_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  task_id TEXT NOT NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  micro_id TEXT,
  executor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  pr_number INT,
  pr_url TEXT,
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  tl_review_status TEXT NOT NULL DEFAULT 'pending',
  tl_review_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  tl_summary TEXT,
  merged_at TIMESTAMPTZ,
  workspace_cleaned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_slug, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_pull_requests_project
  ON task_pull_requests (tenant_id, project_slug);

-- Micro release PR (tech-lead -> default)
CREATE TABLE IF NOT EXISTS micro_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  micro_id TEXT NOT NULL,
  release_pr_number INT,
  release_pr_url TEXT,
  release_status TEXT NOT NULL DEFAULT 'pending_qa',
  integration_qa_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  release_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  merged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_slug, micro_id)
);
