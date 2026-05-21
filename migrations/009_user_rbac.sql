-- RBAC: roles, passwords, per-executor Cursor keys, job attribution, plan user quota

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS users_max INT NOT NULL DEFAULT 5;

UPDATE tenants SET users_max = CASE plan_id
  WHEN 'team' THEN 10
  WHEN 'scale' THEN 25
  WHEN 'business' THEN 50
  WHEN 'enterprise' THEN 100
  ELSE 5
END
WHERE users_max = 5 OR users_max IS NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS cursor_api_key_encrypted TEXT;

UPDATE users SET role = 'auditor' WHERE role = 'admin' OR role NOT IN ('executor', 'auditor', 'viewer');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('executor', 'auditor', 'viewer'));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users(tenant_id);

-- Migrate legacy tenant API key to first executor if any
DO $$
DECLARE
  r RECORD;
  enc TEXT;
BEGIN
  FOR r IN
    SELECT t.id AS tenant_id, t.cursor_api_key_encrypted AS enc
    FROM tenants t
    WHERE t.cursor_api_key_encrypted IS NOT NULL
  LOOP
    UPDATE users u
    SET cursor_api_key_encrypted = r.enc
    WHERE u.tenant_id = r.tenant_id
      AND u.role = 'executor'
      AND u.cursor_api_key_encrypted IS NULL
      AND u.id = (
        SELECT id FROM users
        WHERE tenant_id = r.tenant_id AND role = 'executor'
        ORDER BY created_at ASC LIMIT 1
      );
    IF NOT FOUND THEN
      UPDATE users u
      SET cursor_api_key_encrypted = r.enc, role = 'executor'
      WHERE u.tenant_id = r.tenant_id
        AND u.cursor_api_key_encrypted IS NULL
        AND u.id = (
          SELECT id FROM users
          WHERE tenant_id = r.tenant_id
          ORDER BY created_at ASC LIMIT 1
        );
    END IF;
  END LOOP;
END $$;

ALTER TABLE tenants DROP COLUMN IF EXISTS cursor_api_key_encrypted;
