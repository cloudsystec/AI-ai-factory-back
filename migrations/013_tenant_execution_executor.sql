-- Executor que iniciou Play (chave Cursor por utilizador nos jobs automáticos)
ALTER TABLE tenant_execution
  ADD COLUMN IF NOT EXISTS executor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
