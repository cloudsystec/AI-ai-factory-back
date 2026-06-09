-- Tutorial guiado: flag por utilizador (existentes ficam false via DEFAULT)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tutorial_pending BOOLEAN NOT NULL DEFAULT false;
