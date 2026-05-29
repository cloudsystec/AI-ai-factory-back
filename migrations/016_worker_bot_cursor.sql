-- Bots por slot (tenant_workers) + billing dual (bot vs executor)

ALTER TABLE tenant_workers
  ADD COLUMN IF NOT EXISTS cursor_bot_email TEXT,
  ADD COLUMN IF NOT EXISTS cursor_worker_api_key_encrypted TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'tenant_workers'
      AND c.contype = 'p'
      AND array_length(c.conkey, 1) = 1
  ) THEN
    ALTER TABLE tenant_workers DROP CONSTRAINT tenant_workers_pkey;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'tenant_workers' AND c.contype = 'p'
  ) THEN
    ALTER TABLE tenant_workers ADD PRIMARY KEY (tenant_id, worker_slot);
  END IF;
END $$;

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS bot_email TEXT,
  ADD COLUMN IF NOT EXISTS worker_slot INT;
