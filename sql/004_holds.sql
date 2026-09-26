CREATE TABLE IF NOT EXISTS credits_holds (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES credits_accounts (id),
  credits INTEGER NOT NULL,
  ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credits_holds_credits CHECK (credits > 0),
  CONSTRAINT credits_holds_status CHECK (
    status IN ('active', 'settled', 'released', 'expired')
  )
);

CREATE INDEX IF NOT EXISTS credits_holds_account_active
  ON credits_holds (account)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS credits_holds_expires
  ON credits_holds (expires_at)
  WHERE status = 'active';
