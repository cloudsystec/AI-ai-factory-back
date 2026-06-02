-- Corrigir backfill: CB zero nunca é confirmado Cursor (ex.: taxa mínima $0.01).
UPDATE usage_events
SET charge_source = 'fee_minimum'
WHERE charge_source = 'cursor_admin_api'
  AND cost_base_usd = 0;

UPDATE jobs
SET charge_source = 'fee_minimum'
WHERE charge_source = 'cursor_admin_api'
  AND cost_base_usd = 0;
