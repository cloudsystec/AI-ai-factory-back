-- Origem da cobrança exposta ao cliente (sem cost_base).
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS charge_source TEXT NOT NULL DEFAULT 'estimate';

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS charge_source TEXT;

COMMENT ON COLUMN usage_events.charge_source IS
  'cursor_admin_api = confirmado Cursor; estimate* / pending = estimativa ou pendente';

-- Jobs já completados: assumir confirmado se tinham custo > 0 (melhor esforço).
UPDATE usage_events
SET charge_source = 'cursor_admin_api'
WHERE charge_source = 'estimate'
  AND charge_usd > 0
  AND status = 'completed';
