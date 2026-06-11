-- Password security: mandatory change, lockout, recovery rate-limit

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_must_change BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_password_recovery_sent_at TIMESTAMPTZ NULL;
