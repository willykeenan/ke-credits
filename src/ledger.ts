/// <reference types="node" />
import { createHash, randomUUID } from "node:crypto";
import type { Db, Sql } from "./db.js";
import {
  AccountNotFound,
  AccountSuspended,
  EntryNotFound,
  IdempotencyConflict,
  InsufficientCredits,
  InvalidAmount,
  PurchaseNotFound,
  RefundLimitExceeded,
} from "./errors.js";

export type EntryKind =
  | "grant"
  | "spend"
  | "refund"
  | "clawback"
  | "adjust"
  | "expire"
  | "reverse";

export type Entry = {
  id: string;
  account: string;
  delta: number;
  kind: EntryKind;
  ref: string | null;
  meta: Record<string, unknown>;
  at: string;
};

export type Result = { entryId: string; balance: number; replayed: boolean };

type StoredResult = { entry_id: string; request_hash: string; balance: number; payload: unknown };

function stable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = stable(obj[key]);
  return out;
}

export function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex");
}

function requirePositiveInt(n: unknown, label = "credits"): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new InvalidAmount(`${label} must be a positive integer`);
  }
  return n;
}

function requireAccountId(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new InvalidAmount("account id must be a non-empty string");
  }
  return id;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function asMeta(value: unknown): Record<string, unknown> {
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

function mapEntry(row: Record<string, unknown>): Entry {
  return {
    id: String(row.id),
    account: String(row.account),
    delta: Number(row.delta),
    kind: row.kind as EntryKind,
    ref: row.ref == null ? null : String(row.ref),
    meta: asMeta(row.meta),
    at: asIso(row.at),
  };
}

/** suspended_reason prefix for a suspension that open disputes caused. */
const DISPUTE_REASON = "dispute:";

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

async function sumBalance(sql: Sql, account: string): Promise<number> {
  const res = await sql.query<{ balance: number }>(
    "SELECT COALESCE(SUM(delta), 0)::int AS balance FROM credits_ledger WHERE account = $1",
    [account],
  );
  return Number(res.rows[0]?.balance ?? 0);
}

async function loadResult(sql: Sql, key: string): Promise<StoredResult | undefined> {
  const res = await sql.query<StoredResult>(
    "SELECT entry_id, request_hash, balance, payload FROM credits_operation_results WHERE idempotency_key = $1",
    [key],
  );
  return res.rows[0];
}

export class Ledger {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, opts?: { now?: () => Date }) {
    this.db = db;
    this.now = opts?.now ?? (() => new Date());
  }

  async createAccount(id: string, meta?: Record<string, unknown>): Promise<void> {
    requireAccountId(id);
    await this.db.query(
      `INSERT INTO credits_accounts (id, meta) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, JSON.stringify(meta ?? {})],
    );
  }

  async balance(account: string): Promise<number> {
    requireAccountId(account);
    return sumBalance(this.db, account);
  }

  async history(
    account: string,
    opts?: { limit?: number; before?: string },
  ): Promise<Entry[]> {
    requireAccountId(account);
    const limit = opts?.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new InvalidAmount("history limit must be a positive integer");
    }
    const before = opts?.before;
    const res = before
      ? await this.db.query<Record<string, unknown>>(
          `SELECT id, account, delta, kind, ref, meta, at
           FROM credits_ledger
           WHERE account = $1
             AND (at, id) < (SELECT at, id FROM credits_ledger WHERE id = $2)
           ORDER BY at DESC, id DESC
           LIMIT $3`,
          [account, before, limit],
        )
      : await this.db.query<Record<string, unknown>>(
          `SELECT id, account, delta, kind, ref, meta, at
           FROM credits_ledger
           WHERE account = $1
           ORDER BY at DESC, id DESC
           LIMIT $2`,
          [account, limit],
        );
    return res.rows.map(mapEntry);
  }

  async grant(input: {
    account: string;
    credits: number;
    ref: string;
    idempotencyKey: string;
    meta?: object;
  }): Promise<Result> {
    return this.db.transaction((tx) => this.grantIn(tx, input));
  }

  async spend(
    input: {
      account: string;
      credits: number;
      ref: string;
      idempotencyKey: string;
      meta?: object;
    },
    tx?: Sql,
  ): Promise<Result> {
    if (tx) return this.spendIn(tx, input);
    return this.db.transaction((inner) => this.spendIn(inner, input));
  }

  async refund(input: {
    account: string;
    spendEntryId: string;
    credits?: number;
    idempotencyKey: string;
    reason?: string;
  }): Promise<Result> {
    return this.db.transaction((tx) => this.refundIn(tx, input));
  }

  async clawback(input: {
    account: string;
    purchaseRef: string;
    fraction: number;
    idempotencyKey: string;
    reason: string;
  }): Promise<Result> {
    return this.db.transaction((tx) => this.clawbackIn(tx, input));
  }

  async suspend(account: string, reason: string): Promise<void> {
    requireAccountId(account);
    await this.db.transaction(async (tx) => {
      const row = await lockAccount(tx, account);
      if (row.suspended_at) {
        await tx.query(
          `UPDATE credits_accounts
           SET suspended_reason = $2
           WHERE id = $1`,
          [account, reason],
        );
        return;
      }
      await tx.query(
        `UPDATE credits_accounts
         SET suspended_at = $2, suspended_reason = $3
         WHERE id = $1`,
        [account, this.now().toISOString(), reason],
      );
    });
  }

  /**
   * Track one payment dispute. While any dispute on the account is open the
   * account is suspended (spends refused, grants still recorded). A closing
   * status is terminal, so a "won" delivered before its "created" never
   * reopens the dispute. Only a suspension that disputes caused is lifted;
   * one set by the operator or by clawback debt stays.
   */
  async setDisputeStatus(
    account: string,
    disputeId: string,
    status: "open" | "won" | "lost" | "closed",
  ): Promise<{ suspended: boolean }> {
    requireAccountId(account);
    if (typeof disputeId !== "string" || disputeId.length === 0) {
      throw new InvalidAmount("disputeId must be a non-empty string");
    }
    if (!["open", "won", "lost", "closed"].includes(status)) {
      throw new InvalidAmount("status must be open, won, lost or closed");
    }
    return this.db.transaction(async (tx) => {
      const row = await lockAccount(tx, account);
      if (status === "open") {
        await tx.query(
          `INSERT INTO credits_disputes (id, account, status) VALUES ($1, $2, 'open')
           ON CONFLICT (id) DO NOTHING`,
          [disputeId, account],
        );
      } else {
        await tx.query(
          `INSERT INTO credits_disputes (id, account, status) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
           WHERE credits_disputes.status = 'open'`,
          [disputeId, account, status],
        );
      }
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM credits_disputes WHERE account = $1 AND status = 'open'
         ORDER BY updated_at ASC, id ASC LIMIT 1`,
        [account],
      );
      const openId = open.rows[0]?.id;
      if (openId) {
        if (!row.suspended_at) {
          await tx.query(
            `UPDATE credits_accounts SET suspended_at = $2, suspended_reason = $3 WHERE id = $1`,
            [account, this.now().toISOString(), `${DISPUTE_REASON}${openId}`],
          );
        }
        return { suspended: true };
      }
      if (row.suspended_at && String(row.suspended_reason ?? "").startsWith(DISPUTE_REASON)) {
        await tx.query(
          `UPDATE credits_accounts SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
          [account],
        );
        return { suspended: false };
      }
      return { suspended: Boolean(row.suspended_at) };
    });
  }

  async unsuspend(account: string): Promise<void> {
    requireAccountId(account);
    await this.db.transaction(async (tx) => {
      await lockAccount(tx, account);
      await tx.query(
        `UPDATE credits_accounts
         SET suspended_at = NULL, suspended_reason = NULL
         WHERE id = $1`,
        [account],
      );
    });
  }

  private async withIdempotency(
    sql: Sql,
    key: string,
    hash: string,
    run: () => Promise<{ entryId: string; balance: number; payload?: Record<string, unknown> }>,
  ): Promise<Result> {
    const claimed = await sql.query<{ idempotency_key: string }>(
      `INSERT INTO credits_operation_results (idempotency_key, request_hash, entry_id, balance, payload)
       VALUES ($1, $2, 'pending', 0, '{}'::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [key, hash],
    );
    if (!claimed.rows.length) {
      const existing = await loadResult(sql, key);
      if (!existing || existing.request_hash !== hash || existing.entry_id === "pending") {
        throw new IdempotencyConflict(key);
      }
      return {
        entryId: existing.entry_id,
        balance: Number(existing.balance),
        replayed: true,
      };
    }
    try {
      const produced = await run();
      await sql.query(
        `UPDATE credits_operation_results
         SET entry_id = $2, balance = $3, payload = $4::jsonb
         WHERE idempotency_key = $1`,
        [key, produced.entryId, produced.balance, JSON.stringify(produced.payload ?? {})],
      );
      return { entryId: produced.entryId, balance: produced.balance, replayed: false };
    } catch (error) {
      try {
        await sql.query(
          `DELETE FROM credits_operation_results
           WHERE idempotency_key = $1 AND entry_id = 'pending'`,
          [key],
        );
      } catch {
        // The surrounding transaction may already be aborted.
      }
      throw error;
    }
  }

  private async insertEntry(
    sql: Sql,
    row: {
      account: string;
      delta: number;
      kind: EntryKind;
      ref: string | null;
      meta: Record<string, unknown>;
      originalId?: string | null;
    },
  ): Promise<{ id: string; at: string }> {
    const id = randomUUID();
    const at = this.now().toISOString();
    await sql.query(
      `INSERT INTO credits_ledger (id, account, delta, kind, ref, meta, original_id, at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        id,
        row.account,
        row.delta,
        row.kind,
        row.ref,
        JSON.stringify(row.meta),
        row.originalId ?? null,
        at,
      ],
    );
    return { id, at };
  }

  private async grantIn(
    sql: Sql,
    input: {
      account: string;
      credits: number;
      ref: string;
      idempotencyKey: string;
      meta?: object;
    },
  ): Promise<Result> {
    const account = requireAccountId(input.account);
    const credits = requirePositiveInt(input.credits);
    if (typeof input.ref !== "string" || input.ref.length === 0) {
      throw new InvalidAmount("ref must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new InvalidAmount("idempotencyKey must be a non-empty string");
    }
    const meta = (input.meta ?? {}) as Record<string, unknown>;
    const hash = requestHash({
      op: "grant",
      account,
      credits,
      ref: input.ref,
      meta,
    });
    return this.withIdempotency(sql, input.idempotencyKey, hash, async () => {
      await lockAccount(sql, account);
      const inserted = await this.insertEntry(sql, {
        account,
        delta: credits,
        kind: "grant",
        ref: input.ref,
        meta,
      });
      const balance = await sumBalance(sql, account);
      return { entryId: inserted.id, balance };
    });
  }

  private async spendIn(
    sql: Sql,
    input: {
      account: string;
      credits: number;
      ref: string;
      idempotencyKey: string;
      meta?: object;
    },
  ): Promise<Result> {
    const account = requireAccountId(input.account);
    const credits = requirePositiveInt(input.credits);
    if (typeof input.ref !== "string" || input.ref.length === 0) {
      throw new InvalidAmount("ref must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new InvalidAmount("idempotencyKey must be a non-empty string");
    }
    const meta = (input.meta ?? {}) as Record<string, unknown>;
    const hash = requestHash({
      op: "spend",
      account,
      credits,
      ref: input.ref,
      meta,
    });
    return this.withIdempotency(sql, input.idempotencyKey, hash, async () => {
      const row = await lockAccount(sql, account);
      if (row.suspended_at) {
        throw new AccountSuspended(account, row.suspended_reason);
      }
      const balance = await sumBalance(sql, account);
      if (balance < credits) {
        throw new InsufficientCredits(account, credits, balance);
      }
      const inserted = await this.insertEntry(sql, {
        account,
        delta: -credits,
        kind: "spend",
        ref: input.ref,
        meta,
      });
      return { entryId: inserted.id, balance: balance - credits };
    });
  }

  private async refundIn(
    sql: Sql,
    input: {
      account: string;
      spendEntryId: string;
      credits?: number;
      idempotencyKey: string;
      reason?: string;
    },
  ): Promise<Result> {
    const account = requireAccountId(input.account);
    if (typeof input.spendEntryId !== "string" || input.spendEntryId.length === 0) {
      throw new InvalidAmount("spendEntryId must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new InvalidAmount("idempotencyKey must be a non-empty string");
    }
    const hash = requestHash({
      op: "refund",
      account,
      spendEntryId: input.spendEntryId,
      credits: input.credits ?? null,
      reason: input.reason ?? null,
    });
    return this.withIdempotency(sql, input.idempotencyKey, hash, async () => {
      await lockAccount(sql, account);
      const spend = await sql.query<{
        id: string;
        account: string;
        delta: number;
        kind: string;
      }>(
        `SELECT id, account, delta, kind FROM credits_ledger WHERE id = $1 FOR UPDATE`,
        [input.spendEntryId],
      );
      const spendRow = spend.rows[0];
      if (!spendRow || spendRow.account !== account || spendRow.kind !== "spend") {
        throw new EntryNotFound(input.spendEntryId);
      }
      const spent = -Number(spendRow.delta);
      const prior = await sql.query<{ refunded: number }>(
        `SELECT COALESCE(SUM(delta), 0)::int AS refunded
         FROM credits_ledger
         WHERE original_id = $1 AND kind = 'refund'`,
        [input.spendEntryId],
      );
      const already = Number(prior.rows[0]?.refunded ?? 0);
      const remaining = spent - already;
      const amount =
        input.credits === undefined ? remaining : requirePositiveInt(input.credits);
      if (amount > remaining) {
        throw new RefundLimitExceeded(input.spendEntryId, amount, remaining);
      }
      if (amount <= 0) {
        throw new InvalidAmount("nothing remaining to refund on this spend");
      }
      const meta: Record<string, unknown> = {};
      if (input.reason) meta.reason = input.reason;
      const inserted = await this.insertEntry(sql, {
        account,
        delta: amount,
        kind: "refund",
        ref: `refund:${input.spendEntryId}`,
        meta,
        originalId: input.spendEntryId,
      });
      const balance = await sumBalance(sql, account);
      return { entryId: inserted.id, balance };
    });
  }

  private async clawbackIn(
    sql: Sql,
    input: {
      account: string;
      purchaseRef: string;
      fraction: number;
      idempotencyKey: string;
      reason: string;
    },
  ): Promise<Result> {
    const account = requireAccountId(input.account);
    if (typeof input.purchaseRef !== "string" || input.purchaseRef.length === 0) {
      throw new InvalidAmount("purchaseRef must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new InvalidAmount("idempotencyKey must be a non-empty string");
    }
    if (typeof input.reason !== "string" || input.reason.length === 0) {
      throw new InvalidAmount("reason must be a non-empty string");
    }
    if (
      typeof input.fraction !== "number" ||
      !(input.fraction > 0) ||
      input.fraction > 1 ||
      Number.isNaN(input.fraction)
    ) {
      throw new InvalidAmount("fraction must be in (0, 1]");
    }
    const hash = requestHash({
      op: "clawback",
      account,
      purchaseRef: input.purchaseRef,
      fraction: input.fraction,
      reason: input.reason,
    });
    return this.withIdempotency(sql, input.idempotencyKey, hash, async () => {
      await lockAccount(sql, account);
      const grants = await sql.query<{ id: string; delta: number }>(
        `SELECT id, delta FROM credits_ledger
         WHERE account = $1 AND ref = $2 AND kind = 'grant'
         ORDER BY at ASC, id ASC
         FOR UPDATE`,
        [account, input.purchaseRef],
      );
      if (!grants.rows.length) throw new PurchaseNotFound(input.purchaseRef);
      const granted = grants.rows.reduce((sum, row) => sum + Number(row.delta), 0);
      const prior = await sql.query<{ clawed: number }>(
        `SELECT COALESCE(-SUM(delta), 0)::int AS clawed
         FROM credits_ledger
         WHERE account = $1 AND kind = 'clawback' AND ref = $2`,
        [account, input.purchaseRef],
      );
      const already = Number(prior.rows[0]?.clawed ?? 0);
      const target =
        input.fraction >= 1
          ? granted
          : Math.min(granted, Math.max(0, Math.ceil(granted * input.fraction)));
      const additional = Math.max(0, target - already);
      const balance = await sumBalance(sql, account);
      const take = Math.min(additional, Math.max(0, balance));
      const debt = additional - take;
      const originalId = grants.rows[0].id;
      const meta: Record<string, unknown> = {
        reason: input.reason,
        purchaseRef: input.purchaseRef,
        fraction: input.fraction,
        granted,
        target,
        clawed: take,
        debt,
      };
      let entryId: string;
      let nextBalance = balance;
      if (take > 0 || debt > 0) {
        const inserted = await this.insertEntry(sql, {
          account,
          delta: take > 0 ? -take : 0,
          kind: "clawback",
          ref: input.purchaseRef,
          meta,
          originalId,
        });
        entryId = inserted.id;
        nextBalance = balance - take;
      } else {
        const last = await sql.query<{ id: string }>(
          `SELECT id FROM credits_ledger
           WHERE account = $1 AND kind = 'clawback' AND ref = $2
           ORDER BY at DESC, id DESC
           LIMIT 1`,
          [account, input.purchaseRef],
        );
        entryId = last.rows[0]?.id ?? `clawback:${randomUUID()}`;
      }
      if (debt > 0) {
        await sql.query(
          `UPDATE credits_accounts
           SET suspended_at = COALESCE(suspended_at, $2),
               suspended_reason = $3
           WHERE id = $1`,
          [account, this.now().toISOString(), input.reason],
        );
      }
      return { entryId, balance: nextBalance, payload: meta };
    });
  }
}
