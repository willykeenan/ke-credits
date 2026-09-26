CREATE TABLE IF NOT EXISTS credits_ledger (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES credits_accounts (id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  original_id TEXT REFERENCES credits_ledger (id),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credits_ledger_nonzero CHECK (delta <> 0 OR kind = 'clawback'),
  CONSTRAINT credits_ledger_kind CHECK (
    kind IN ('grant', 'spend', 'refund', 'clawback', 'adjust', 'expire', 'reverse')
  ),
  CONSTRAINT credits_ledger_sign CHECK (
    (kind IN ('grant', 'refund') AND delta > 0)
    OR (kind IN ('spend', 'expire', 'reverse') AND delta < 0)
    OR (kind = 'clawback' AND delta <= 0)
    OR (kind = 'adjust' AND delta <> 0)
  )
);

CREATE INDEX IF NOT EXISTS credits_ledger_account_at
  ON credits_ledger (account, at DESC, id DESC);

CREATE INDEX IF NOT EXISTS credits_ledger_account_ref
  ON credits_ledger (account, ref)
  WHERE ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS credits_ledger_original
  ON credits_ledger (original_id)
  WHERE original_id IS NOT NULL;

CREATE OR REPLACE FUNCTION credits_ledger_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credits_ledger is append-only: % is refused', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS credits_ledger_no_update ON credits_ledger;
CREATE TRIGGER credits_ledger_no_update
  BEFORE UPDATE ON credits_ledger
  FOR EACH ROW
  EXECUTE PROCEDURE credits_ledger_refuse_mutation();

DROP TRIGGER IF EXISTS credits_ledger_no_delete ON credits_ledger;
CREATE TRIGGER credits_ledger_no_delete
  BEFORE DELETE ON credits_ledger
  FOR EACH ROW
  EXECUTE PROCEDURE credits_ledger_refuse_mutation();

CREATE OR REPLACE FUNCTION credits_ledger_nonnegative()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bal INTEGER;
BEGIN
  PERFORM 1 FROM credits_accounts WHERE id = NEW.account FOR UPDATE;
  SELECT COALESCE(SUM(delta), 0)::int INTO bal
  FROM credits_ledger
  WHERE account = NEW.account;
  IF bal < 0 THEN
    RAISE EXCEPTION 'credits balance would go negative for account %', NEW.account;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS credits_ledger_nonnegative ON credits_ledger;
CREATE TRIGGER credits_ledger_nonnegative
  AFTER INSERT ON credits_ledger
  FOR EACH ROW
  EXECUTE PROCEDURE credits_ledger_nonnegative();
