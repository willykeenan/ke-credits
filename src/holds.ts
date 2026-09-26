/// <reference types="node" />
import { randomUUID } from "node:crypto";
import type { Db, Sql } from "./db.js";
import {
  AccountNotFound,
  AccountSuspended,
  HoldExceedsReserved,
  HoldNotActive,
  HoldNotFound,
  IdempotencyConflict,
  InsufficientCredits,
  InvalidAmount,
} from "./errors.js";
import { Ledger, requestHash, type Result } from "./ledger.js";

type HoldRow = {
  id: string;
  account: string;
  credits: number;
  ref: string;
  status: string;
  expires_at: unknown;
};

function requirePositiveInt(n: unknown, label = "credits"): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new InvalidAmount(`${label} must be a positive integer`);
  }
  return n;
}

async function lockAccount(
  sql: Sql,
  account: string,
): Promise<{ id: string; suspended_at: unknown; suspended_reason: string | null }> {
  const res = await sql.query<{
    id: string;
    suspended_at: unknown;
    suspended_reason: string | null;
  }>(
    "SELECT id, suspended_at, suspended_reason FROM credits_accounts WHERE id = $1 FOR UPDATE",
    [account],
  );
  const row = res.rows[0];
  if (!row) throw new AccountNotFound(account);
  return row;
}

async function lockHold(sql: Sql, holdId: string): Promise<HoldRow> {
  const res = await sql.query<HoldRow>(
    `SELECT id, account, credits, ref, status, expires_at
     FROM credits_holds WHERE id = $1 FOR UPDATE`,
    [holdId],
  );
  const row = res.rows[0];
  if (!row) throw new HoldNotFound(holdId);
  return row;
}

async function ledgerBalance(sql: Sql, account: string): Promise<number> {
  const res = await sql.query<{ balance: number }>(
    "SELECT COALESCE(SUM(delta), 0)::int AS balance FROM credits_ledger WHERE account = $1",
    [account],
  );
  return Number(res.rows[0]?.balance ?? 0);
}

async function activeHeld(sql: Sql, account: string, nowIso: string): Promise<number> {
  const res = await sql.query<{ held: number }>(
    `SELECT COALESCE(SUM(credits), 0)::int AS held
     FROM credits_holds
     WHERE account = $1 AND status = 'active' AND expires_at > $2`,
    [account, nowIso],
  );
  return Number(res.rows[0]?.held ?? 0);
}

async function loadResult(
  sql: Sql,
  key: string,
): Promise<{ entry_id: string; request_hash: string; balance: number; payload: unknown } | undefined> {
  const res = await sql.query<{
    entry_id: string;
    request_hash: string;
    balance: number;
    payload: unknown;
  }>(
    `SELECT entry_id, request_hash, balance, payload
     FROM credits_operation_results WHERE idempotency_key = $1`,
    [key],
  );
  return res.rows[0];
}

export class Holds {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly now: () => Date;
  private readonly defaultTtlSeconds: number;

  constructor(
    db: Db,
    ledger: Ledger,
    opts?: { now?: () => Date; defaultTtlSeconds?: number },
  ) {
    this.db = db;
    this.ledger = ledger;
    this.now = opts?.now ?? (() => new Date());
    this.defaultTtlSeconds = opts?.defaultTtlSeconds ?? 3600;
  }

  async available(account: string): Promise<number> {
    const nowIso = this.now().toISOString();
    const [balance, held] = await Promise.all([
      ledgerBalance(this.db, account),
      activeHeld(this.db, account, nowIso),
    ]);
    return balance - held;
  }

  async reserve(input: {
    account: string;
    credits: number;
    ref: string;
    idempotencyKey: string;
    ttlSeconds?: number;
  }): Promise<{ holdId: string; available: number }> {
    const account = input.account;
    const credits = requirePositiveInt(input.credits);
    if (typeof input.ref !== "string" || input.ref.length === 0) {
      throw new InvalidAmount("ref must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new InvalidAmount("idempotencyKey must be a non-empty string");
    }
    const ttl = input.ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new InvalidAmount("ttlSeconds must be a positive integer");
    }
    const hash = requestHash({
      op: "hold.reserve",
      account,
      credits,
      ref: input.ref,
      ttlSeconds: ttl,
    });
    return this.db.transaction(async (tx) => {
      const claimed = await tx.query<{ idempotency_key: string }>(
        `INSERT INTO credits_operation_results (idempotency_key, request_hash, entry_id, balance, payload)
         VALUES ($1, $2, 'pending', 0, '{}'::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [input.idempotencyKey, hash],
      );
      if (!claimed.rows.length) {
        const existing = await loadResult(tx, input.idempotencyKey);
        if (!existing || existing.request_hash !== hash) {
          throw new IdempotencyConflict(input.idempotencyKey);
        }
        const payload = asPayload(existing.payload);
        return {
          holdId: String(payload.holdId ?? existing.entry_id),
          available: Number(payload.available ?? existing.balance),
        };
      }
      const row = await lockAccount(tx, account);
      if (row.suspended_at) {
        throw new AccountSuspended(account, row.suspended_reason);
      }
      const now = this.now();
      const nowIso = now.toISOString();
      const balance = await ledgerBalance(tx, account);
      const held = await activeHeld(tx, account, nowIso);
      const available = balance - held;
      if (available < credits) {
        throw new InsufficientCredits(account, credits, available);
      }
      const holdId = randomUUID();
      const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
      await tx.query(
        `INSERT INTO credits_holds (id, account, credits, ref, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
        [holdId, account, credits, input.ref, expiresAt, nowIso],
      );
      const nextAvailable = available - credits;
      await tx.query(
        `UPDATE credits_operation_results
         SET entry_id = $2, balance = $3, payload = $4::jsonb
         WHERE idempotency_key = $1`,
        [
          input.idempotencyKey,
          holdId,
          nextAvailable,
          JSON.stringify({ holdId, available: nextAvailable }),
        ],
      );
      return { holdId, available: nextAvailable };
    });
  }

  async settle(input: {
    holdId: string;
    credits: number;
    idempotencyKey: string;
  }): Promise<Result> {
    const credits = requirePositiveInt(input.credits);
    if (typeof input.holdId !== "string" || input.holdId.length === 0) {
      throw new InvalidAmount("holdId must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new InvalidAmount("idempotencyKey must be a non-empty string");
    }
    return this.db.transaction(async (tx) => {
      const hold = await lockHold(tx, input.holdId);
      const spendMeta = { holdId: hold.id };
      const hash = requestHash({
        op: "spend",
        account: hold.account,
        credits,
        ref: hold.ref,
        meta: spendMeta,
      });
      if (hold.status !== "active") {
        const existing = await loadResult(tx, input.idempotencyKey);
        if (existing) {
          if (existing.request_hash !== hash) {
            throw new IdempotencyConflict(input.idempotencyKey);
          }
          return {
            entryId: existing.entry_id,
            balance: Number(existing.balance),
            replayed: true,
          };
        }
        throw new HoldNotActive(hold.id, hold.status);
      }
      const reserved = Number(hold.credits);
      if (credits > reserved) {
        throw new HoldExceedsReserved(hold.id, credits, reserved);
      }
      await lockAccount(tx, hold.account);
      const result = await this.ledger.spend(
        {
          account: hold.account,
          credits,
          ref: hold.ref,
          idempotencyKey: input.idempotencyKey,
          meta: spendMeta,
        },
        tx,
      );
      await tx.query(
        `UPDATE credits_holds SET status = 'settled' WHERE id = $1`,
        [hold.id],
      );
      return result;
    });
  }

  async release(input: {
    holdId: string;
    idempotencyKey: string;
  }): Promise<{ released: number }> {
    if (typeof input.holdId !== "string" || input.holdId.length === 0) {
      throw new InvalidAmount("holdId must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new InvalidAmount("idempotencyKey must be a non-empty string");
    }
    const hash = requestHash({ op: "hold.release", holdId: input.holdId });
    return this.db.transaction(async (tx) => {
      const claimed = await tx.query<{ idempotency_key: string }>(
        `INSERT INTO credits_operation_results (idempotency_key, request_hash, entry_id, balance, payload)
         VALUES ($1, $2, 'pending', 0, '{}'::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [input.idempotencyKey, hash],
      );
      if (!claimed.rows.length) {
        const existing = await loadResult(tx, input.idempotencyKey);
        if (!existing || existing.request_hash !== hash) {
          throw new IdempotencyConflict(input.idempotencyKey);
        }
        return { released: Number(existing.balance) };
      }
      const hold = await lockHold(tx, input.holdId);
      if (hold.status !== "active") {
        throw new HoldNotActive(hold.id, hold.status);
      }
      await tx.query(`UPDATE credits_holds SET status = 'released' WHERE id = $1`, [
        hold.id,
      ]);
      const released = Number(hold.credits);
      await tx.query(
        `UPDATE credits_operation_results
         SET entry_id = $2, balance = $3, payload = $4::jsonb
         WHERE idempotency_key = $1`,
        [
          input.idempotencyKey,
          hold.id,
          released,
          JSON.stringify({ holdId: hold.id, released }),
        ],
      );
      return { released };
    });
  }

  async expireDue(): Promise<number> {
    const nowIso = this.now().toISOString();
    const res = await this.db.query<{ id: string }>(
      `UPDATE credits_holds
       SET status = 'expired'
       WHERE status = 'active' AND expires_at <= $1
       RETURNING id`,
      [nowIso],
    );
    return res.rows.length;
  }
}

function asPayload(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
