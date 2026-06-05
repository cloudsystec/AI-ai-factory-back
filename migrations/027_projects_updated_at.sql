-- Git managed / provision / migrate services actualizam projects.updated_at
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
