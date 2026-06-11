ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS block_reason TEXT
    CHECK (block_reason IS NULL OR block_reason IN ('security', 'payment', 'other')),
  ADD COLUMN IF NOT EXISTS block_note TEXT,
  ADD COLUMN IF NOT EXISTS blocked_by TEXT;

CREATE INDEX IF NOT EXISTS tenants_blocked_at_idx
  ON tenants (blocked_at)
  WHERE blocked_at IS NOT NULL;
