-- Permite status 'verifying' (pós-provision, antes de confirmar URL online)

ALTER TABLE project_railway_deployments
  DROP CONSTRAINT IF EXISTS project_railway_deployments_status_check;

ALTER TABLE project_railway_deployments
  ADD CONSTRAINT project_railway_deployments_status_check CHECK (
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
  );
