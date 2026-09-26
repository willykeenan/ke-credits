CREATE TABLE IF NOT EXISTS credits_accounts (
  id TEXT PRIMARY KEY,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
