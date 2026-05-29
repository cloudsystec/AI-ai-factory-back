-- Fase 1: serviço configurado (repo/vars/volume) sem build Docker
ALTER TABLE tenant_worker_deployments
  DROP CONSTRAINT IF EXISTS tenant_worker_deployments_status_check;

ALTER TABLE tenant_worker_deployments
  ADD CONSTRAINT tenant_worker_deployments_status_check
  CHECK (status IN ('pending', 'provisioning', 'configured', 'deployed', 'failed'));
