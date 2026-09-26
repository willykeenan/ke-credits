/// <reference types="node" />
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { MigrationDrift } from "./errors.js";

const SQL_001 = `CREATE TABLE IF NOT EXISTS credits_accounts (
  id TEXT PRIMARY KEY,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const SQL_002 = `CREATE TABLE IF NOT EXISTS credits_ledger (
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
`;

const SQL_003 = `CREATE TABLE IF NOT EXISTS credits_operation_results (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  balance INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const SQL_004 = `CREATE TABLE IF NOT EXISTS credits_holds (
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
`;

const SQL_005 = `CREATE TABLE IF NOT EXISTS credits_disputes (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES credits_accounts (id),
  status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credits_disputes_status CHECK (status IN ('open', 'won', 'lost', 'closed'))
);

CREATE INDEX IF NOT EXISTS credits_disputes_account_open
  ON credits_disputes (account)
  WHERE status = 'open';
`;

export const MIGRATIONS: { id: string; sql: string }[] = [
  { id: "001_accounts", sql: SQL_001 },
  { id: "002_ledger", sql: SQL_002 },
  { id: "003_operation_results", sql: SQL_003 },
  { id: "004_holds", sql: SQL_004 },
  { id: "005_disputes", sql: SQL_005 },
];

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS credits_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Split a SQL script into statements, preserving dollar-quoted bodies. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) {
        buf += sql.slice(i);
        break;
      }
      buf += sql.slice(i, nl);
      i = nl;
      continue;
    }
    if (ch === "'") {
      buf += ch;
      i += 1;
      while (i < sql.length) {
        buf += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "$") {
      const rest = sql.slice(i);
      const tag = rest.match(/^\$[a-zA-Z0-9_]*\$/);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) {
          throw new Error("unterminated dollar-quoted string in migration SQL");
        }
        buf += sql.slice(i, end + tag[0].length);
        i = end + tag[0].length;
        continue;
      }
    }
    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt) statements.push(stmt);
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function migrate(db: Db): Promise<{ applied: string[] }> {
  return db.transaction(async (tx) => {
    await tx.query(BOOTSTRAP);
    const applied: string[] = [];
    for (const migration of MIGRATIONS) {
      const checksum = migrationChecksum(migration.sql);
      const existing = await tx.query<{ checksum: string }>(
        "SELECT checksum FROM credits_schema_migrations WHERE id = $1",
        [migration.id],
      );
      const stored = existing.rows[0]?.checksum;
      if (stored) {
        if (stored !== checksum) {
          throw new MigrationDrift(migration.id, checksum, stored);
        }
        continue;
      }
      for (const statement of splitSqlStatements(migration.sql)) {
        await tx.query(statement);
      }
      await tx.query(
        "INSERT INTO credits_schema_migrations (id, checksum) VALUES ($1, $2)",
        [migration.id, checksum],
      );
      applied.push(migration.id);
    }
    return { applied };
  });
}
