-- Cotação USD→BRL para exibição ao cliente (custo interno CB permanece só na BD).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cotation NUMERIC(8, 4) NOT NULL DEFAULT 5.10;

COMMENT ON COLUMN tenants.cotation IS 'Taxa USD→BRL para conversão visual de cobrança (charge) no front';
