CREATE TABLE IF NOT EXISTS credits_disputes (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES credits_accounts (id),
  status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credits_disputes_status CHECK (status IN ('open', 'won', 'lost', 'closed'))
);

CREATE INDEX IF NOT EXISTS credits_disputes_account_open
  ON credits_disputes (account)
  WHERE status = 'open';
