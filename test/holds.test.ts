import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountSuspended,
  HoldExceedsReserved,
  HoldNotActive,
  IdempotencyConflict,
  InsufficientCredits,
} from "../src/errors.ts";
import { Holds } from "../src/holds.ts";
import { Ledger } from "../src/ledger.ts";
import { migrate } from "../src/schema.ts";
import { pgliteDb } from "./helpers.ts";

async function fresh(now?: { current: Date }) {
  const db = await pgliteDb();
  await migrate(db);
  const clock = now ? () => now.current : () => new Date();
  const ledger = new Ledger(db, { now: clock });
  const holds = new Holds(db, ledger, { now: clock, defaultTtlSeconds: 60 });
  await ledger.createAccount("acct");
  await ledger.grant({
    account: "acct",
    credits: 20,
    ref: "pack",
    idempotencyKey: "g",
  });
  return { db, ledger, holds };
}

test("reserve reduces available, not ledger balance", async () => {
  const { ledger, holds } = await fresh();
  const reserved = await holds.reserve({
    account: "acct",
    credits: 7,
    ref: "job-1",
    idempotencyKey: "r1",
  });
  assert.equal(reserved.available, 13);
  assert.equal(await ledger.balance("acct"), 20);
  assert.equal(await holds.available("acct"), 13);
  const replay = await holds.reserve({
    account: "acct",
    credits: 7,
    ref: "job-1",
    idempotencyKey: "r1",
  });
  assert.equal(replay.holdId, reserved.holdId);
  assert.equal(replay.available, 13);
  await assert.rejects(
    () =>
      holds.reserve({
        account: "acct",
        credits: 8,
        ref: "job-1",
        idempotencyKey: "r1",
      }),
    (err: unknown) => err instanceof IdempotencyConflict,
  );
});

test("settle spends up to the reserved amount and releases the remainder", async () => {
  const { ledger, holds } = await fresh();
  const { holdId } = await holds.reserve({
    account: "acct",
    credits: 10,
    ref: "job-2",
    idempotencyKey: "r2",
  });
  assert.equal(await holds.available("acct"), 10);
  const settled = await holds.settle({
    holdId,
    credits: 6,
    idempotencyKey: "s2",
  });
  assert.equal(settled.replayed, false);
  assert.equal(settled.balance, 14);
  assert.equal(await ledger.balance("acct"), 14);
  assert.equal(await holds.available("acct"), 14);
  const history = await ledger.history("acct");
  const spend = history.find((e) => e.kind === "spend");
  assert.ok(spend);
  assert.equal(spend!.delta, -6);
  assert.equal(spend!.meta.holdId, holdId);
});

test("settle refuses more than reserved and refuses a second settle", async () => {
  const { holds } = await fresh();
  const { holdId } = await holds.reserve({
    account: "acct",
    credits: 5,
    ref: "job-3",
    idempotencyKey: "r3",
  });
  await assert.rejects(
    () => holds.settle({ holdId, credits: 6, idempotencyKey: "too-much" }),
    (err: unknown) => err instanceof HoldExceedsReserved,
  );
  const first = await holds.settle({
    holdId,
    credits: 5,
    idempotencyKey: "s3",
  });
  const replay = await holds.settle({
    holdId,
    credits: 5,
    idempotencyKey: "s3",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.entryId, first.entryId);
  await assert.rejects(
    () => holds.settle({ holdId, credits: 5, idempotencyKey: "s3-again" }),
    (err: unknown) => err instanceof HoldNotActive,
  );
});

test("release restores available without spending", async () => {
  const { ledger, holds } = await fresh();
  const { holdId } = await holds.reserve({
    account: "acct",
    credits: 9,
    ref: "job-4",
    idempotencyKey: "r4",
  });
  const released = await holds.release({ holdId, idempotencyKey: "rel-4" });
  assert.equal(released.released, 9);
  assert.equal(await ledger.balance("acct"), 20);
  assert.equal(await holds.available("acct"), 20);
  const replay = await holds.release({ holdId, idempotencyKey: "rel-4" });
  assert.equal(replay.released, 9);
  await assert.rejects(
    () => holds.release({ holdId, idempotencyKey: "rel-4b" }),
    (err: unknown) => err instanceof HoldNotActive,
  );
});

test("expireDue releases expired holds", async () => {
  const clock = { current: new Date("2026-01-01T00:00:00.000Z") };
  const { ledger, holds } = await fresh(clock);
  await holds.reserve({
    account: "acct",
    credits: 4,
    ref: "job-5",
    idempotencyKey: "r5",
    ttlSeconds: 10,
  });
  assert.equal(await holds.available("acct"), 16);
  clock.current = new Date("2026-01-01T00:00:09.000Z");
  assert.equal(await holds.expireDue(), 0);
  clock.current = new Date("2026-01-01T00:00:11.000Z");
  assert.equal(await holds.expireDue(), 1);
  assert.equal(await holds.expireDue(), 0);
  assert.equal(await ledger.balance("acct"), 20);
  assert.equal(await holds.available("acct"), 20);
});

test("reserve fails when available is too low or the account is suspended", async () => {
  const { ledger, holds } = await fresh();
  await holds.reserve({
    account: "acct",
    credits: 15,
    ref: "job-6",
    idempotencyKey: "r6",
  });
  await assert.rejects(
    () =>
      holds.reserve({
        account: "acct",
        credits: 6,
        ref: "job-6b",
        idempotencyKey: "r6b",
      }),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientCredits);
      assert.equal((err as InsufficientCredits).balance, 5);
      return true;
    },
  );
  await ledger.suspend("acct", "review");
  await assert.rejects(
    () =>
      holds.reserve({
        account: "acct",
        credits: 1,
        ref: "job-6c",
        idempotencyKey: "r6c",
      }),
    (err: unknown) => err instanceof AccountSuspended,
  );
});
