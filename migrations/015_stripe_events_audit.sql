-- Auditoria de webhooks Stripe: payload completo + vínculo opcional ao tenant
ALTER TABLE stripe_events
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

UPDATE stripe_events SET payload = '{}'::jsonb WHERE payload IS NULL;

CREATE INDEX IF NOT EXISTS stripe_events_tenant_idx ON stripe_events(tenant_id);
CREATE INDEX IF NOT EXISTS stripe_events_type_idx ON stripe_events(event_type);
