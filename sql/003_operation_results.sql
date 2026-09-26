CREATE TABLE IF NOT EXISTS credits_operation_results (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  balance INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
