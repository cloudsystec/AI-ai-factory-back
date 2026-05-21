ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS cursor_admin_api_key_encrypted TEXT;
