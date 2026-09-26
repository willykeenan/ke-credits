import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountSuspended,
  IdempotencyConflict,
  InsufficientCredits,
  InvalidPack,
  RefundLimitExceeded,
} from "../src/errors.ts";
import { Ledger } from "../src/ledger.ts";
import { definePacks } from "../src/packs.ts";
import { migrate } from "../src/schema.ts";
import { pgliteDb } from "./helpers.ts";

async function fresh() {
  const db = await pgliteDb();
  await migrate(db);
  const ledger = new Ledger(db);
  await ledger.createAccount("acct");
  return { db, ledger };
}

test("createAccount is idempotent", async () => {
  const { ledger } = await fresh();
  await ledger.createAccount("acct", { plan: "a" });
  await ledger.createAccount("acct", { plan: "b" });
  await ledger.grant({
    account: "acct",
    credits: 1,
    ref: "g",
    idempotencyKey: "g",
  });
  assert.equal(await ledger.balance("acct"), 1);
});

test("grant, spend, balance and history", async () => {
  const { ledger } = await fresh();
  const grant = await ledger.grant({
    account: "acct",
    credits: 20,
    ref: "pack-starter",
    idempotencyKey: "grant-1",
    meta: { source: "test" },
  });
  assert.equal(grant.replayed, false);
  assert.equal(grant.balance, 20);
  const spend = await ledger.spend({
    account: "acct",
    credits: 7,
    ref: "job-1",
    idempotencyKey: "spend-1",
  });
  assert.equal(spend.balance, 13);
  assert.equal(await ledger.balance("acct"), 13);
  const history = await ledger.history("acct");
  assert.equal(history.length, 2);
  assert.equal(history[0].kind, "spend");
  assert.equal(history[0].delta, -7);
  assert.equal(history[1].kind, "grant");
  assert.equal(history[1].delta, 20);
  const page = await ledger.history("acct", { limit: 1 });
  assert.equal(page.length, 1);
  assert.equal(page[0].id, history[0].id);
  const older = await ledger.history("acct", { before: page[0].id });
  assert.equal(older.length, 1);
  assert.equal(older[0].kind, "grant");
});

test("insufficient spend leaves the balance unchanged", async () => {
  const { ledger } = await fresh();
  await ledger.grant({
    account: "acct",
    credits: 4,
    ref: "pack",
    idempotencyKey: "g",
  });
  await assert.rejects(
    () =>
      ledger.spend({
        account: "acct",
        credits: 5,
        ref: "job",
        idempotencyKey: "s",
      }),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientCredits);
      assert.equal((err as InsufficientCredits).balance, 4);
      assert.equal((err as InsufficientCredits).requested, 5);
      return true;
    },
  );
  assert.equal(await ledger.balance("acct"), 4);
});

test("idempotent replay and conflict on a mismatched retry", async () => {
  const { ledger } = await fresh();
  const first = await ledger.grant({
    account: "acct",
    credits: 10,
    ref: "pack",
    idempotencyKey: "same",
  });
  const replay = await ledger.grant({
    account: "acct",
    credits: 10,
    ref: "pack",
    idempotencyKey: "same",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.entryId, first.entryId);
  assert.equal(replay.balance, 10);
  await assert.rejects(
    () =>
      ledger.grant({
        account: "acct",
        credits: 11,
        ref: "pack",
        idempotencyKey: "same",
      }),
    (err: unknown) => err instanceof IdempotencyConflict,
  );
  assert.equal(await ledger.balance("acct"), 10);

  const spend = await ledger.spend({
    account: "acct",
    credits: 3,
    ref: "job",
    idempotencyKey: "spend-key",
  });
  const spendReplay = await ledger.spend({
    account: "acct",
    credits: 3,
    ref: "job",
    idempotencyKey: "spend-key",
  });
  assert.equal(spendReplay.replayed, true);
  assert.equal(spendReplay.entryId, spend.entryId);
  assert.equal(await ledger.balance("acct"), 7);
  await assert.rejects(
    () =>
      ledger.spend({
        account: "acct",
        credits: 4,
        ref: "job",
        idempotencyKey: "spend-key",
      }),
    (err: unknown) => err instanceof IdempotencyConflict,
  );
});

test("refunds are limited to the spent amount", async () => {
  const { ledger } = await fresh();
  await ledger.grant({
    account: "acct",
    credits: 15,
    ref: "pack",
    idempotencyKey: "g",
  });
  const spend = await ledger.spend({
    account: "acct",
    credits: 6,
    ref: "job",
    idempotencyKey: "s",
  });
  const partial = await ledger.refund({
    account: "acct",
    spendEntryId: spend.entryId,
    credits: 2,
    idempotencyKey: "r1",
    reason: "partial provider failure",
  });
  assert.equal(partial.balance, 11);
  await assert.rejects(
    () =>
      ledger.refund({
        account: "acct",
        spendEntryId: spend.entryId,
        credits: 5,
        idempotencyKey: "r2",
      }),
    (err: unknown) => {
      assert.ok(err instanceof RefundLimitExceeded);
      assert.equal((err as RefundLimitExceeded).remaining, 4);
      return true;
    },
  );
  const rest = await ledger.refund({
    account: "acct",
    spendEntryId: spend.entryId,
    idempotencyKey: "r3",
  });
  assert.equal(rest.balance, 15);
  const replay = await ledger.refund({
    account: "acct",
    spendEntryId: spend.entryId,
    idempotencyKey: "r3",
  });
  assert.equal(replay.replayed, true);
  assert.equal(await ledger.balance("acct"), 15);
});

test("proportional clawback and debt suspension", async () => {
  const { ledger } = await fresh();
  await ledger.grant({
    account: "acct",
    credits: 100,
    ref: "pi_test_1",
    idempotencyKey: "g",
  });
  await ledger.spend({
    account: "acct",
    credits: 20,
    ref: "job",
    idempotencyKey: "s",
  });
  const half = await ledger.clawback({
    account: "acct",
    purchaseRef: "pi_test_1",
    fraction: 0.5,
    idempotencyKey: "c-half",
    reason: "partial refund",
  });
  assert.equal(half.replayed, false);
  assert.equal(half.balance, 30);
  assert.equal(await ledger.balance("acct"), 30);
  const claw = (await ledger.history("acct")).find((e) => e.kind === "clawback");
  assert.ok(claw);
  assert.equal(claw!.delta, -50);
  assert.equal(claw!.meta.debt, 0);

  await ledger.createAccount("acct-debt");
  await ledger.grant({
    account: "acct-debt",
    credits: 100,
    ref: "pi_test_2",
    idempotencyKey: "g-debt",
  });
  await ledger.spend({
    account: "acct-debt",
    credits: 40,
    ref: "job-debt",
    idempotencyKey: "s-debt",
  });
  const full = await ledger.clawback({
    account: "acct-debt",
    purchaseRef: "pi_test_2",
    fraction: 1,
    idempotencyKey: "c-full",
    reason: "chargeback",
  });
  assert.equal(full.balance, 0);
  assert.equal(await ledger.balance("acct-debt"), 0);
  const lastClaw = (await ledger.history("acct-debt")).find((e) => e.kind === "clawback");
  assert.ok(lastClaw);
  assert.equal(lastClaw!.delta, -60);
  assert.equal(lastClaw!.meta.debt, 40);
  await assert.rejects(
    () =>
      ledger.spend({
        account: "acct-debt",
        credits: 1,
        ref: "blocked",
        idempotencyKey: "blocked",
      }),
    (err: unknown) => err instanceof AccountSuspended,
  );

  await ledger.createAccount("acct-spent");
  await ledger.grant({
    account: "acct-spent",
    credits: 40,
    ref: "pi_test_3",
    idempotencyKey: "g-spent",
  });
  await ledger.spend({
    account: "acct-spent",
    credits: 40,
    ref: "job-spent",
    idempotencyKey: "s-spent",
  });
  const spentOut = await ledger.clawback({
    account: "acct-spent",
    purchaseRef: "pi_test_3",
    fraction: 1,
    idempotencyKey: "c-spent",
    reason: "chargeback",
  });
  assert.equal(spentOut.balance, 0);
  assert.equal(await ledger.balance("acct-spent"), 0);
  const spentClaw = (await ledger.history("acct-spent")).find((e) => e.kind === "clawback");
  assert.ok(spentClaw);
  assert.equal(spentClaw!.delta, 0);
  assert.equal(spentClaw!.meta.debt, 40);
  assert.equal(spentClaw!.id, spentOut.entryId);
  await assert.rejects(
    () =>
      ledger.spend({
        account: "acct-spent",
        credits: 1,
        ref: "blocked-spent",
        idempotencyKey: "blocked-spent",
      }),
    (err: unknown) => err instanceof AccountSuspended,
  );
});

test("a suspended account cannot spend and unsuspend restores spending", async () => {
  const { ledger } = await fresh();
  await ledger.grant({
    account: "acct",
    credits: 8,
    ref: "pack",
    idempotencyKey: "g",
  });
  await ledger.suspend("acct", "manual review");
  await assert.rejects(
    () =>
      ledger.spend({
        account: "acct",
        credits: 1,
        ref: "job",
        idempotencyKey: "s",
      }),
    (err: unknown) => err instanceof AccountSuspended,
  );
  assert.equal(await ledger.balance("acct"), 8);
  await ledger.unsuspend("acct");
  const spend = await ledger.spend({
    account: "acct",
    credits: 1,
    ref: "job",
    idempotencyKey: "s2",
  });
  assert.equal(spend.balance, 7);
});

test("definePacks validates unique ids and positive integers", () => {
  const packs = definePacks([
    { id: "starter", credits: 100, amount: 1000, currency: "usd", label: "Starter" },
    { id: "studio", credits: 500, amount: 4500, currency: "usd" },
  ]);
  assert.equal(packs.length, 2);
  assert.throws(
    () =>
      definePacks([
        { id: "starter", credits: 100, amount: 1000, currency: "usd" },
        { id: "starter", credits: 200, amount: 2000, currency: "usd" },
      ]),
    (err: unknown) => err instanceof InvalidPack,
  );
  assert.throws(
    () => definePacks([{ id: "bad", credits: 0, amount: 100, currency: "usd" }]),
    (err: unknown) => err instanceof InvalidPack,
  );
  assert.throws(
    () => definePacks([{ id: "bad", credits: 10, amount: 1.5, currency: "usd" }]),
    (err: unknown) => err instanceof InvalidPack,
  );
});

test("spend participates in a caller transaction", async () => {
  const { db, ledger } = await fresh();
  await ledger.grant({
    account: "acct",
    credits: 10,
    ref: "pack",
    idempotencyKey: "g",
  });
  await assert.rejects(() =>
    db.transaction(async (tx) => {
      await ledger.spend(
        {
          account: "acct",
          credits: 4,
          ref: "job",
          idempotencyKey: "in-tx",
        },
        tx,
      );
      throw new Error("boom");
    }),
  );
  assert.equal(await ledger.balance("acct"), 10);
  const spent = await db.transaction((tx) =>
    ledger.spend(
      {
        account: "acct",
        credits: 4,
        ref: "job",
        idempotencyKey: "in-tx",
      },
      tx,
    ),
  );
  assert.equal(spent.replayed, false);
  assert.equal(spent.balance, 6);
});

test("failed spend in a caller transaction does not consume the idempotency key", async () => {
  const { db, ledger } = await fresh();
  await ledger.grant({
    account: "acct",
    credits: 4,
    ref: "pack",
    idempotencyKey: "g",
  });
  await db.transaction(async (tx) => {
    await assert.rejects(
      () =>
        ledger.spend(
          {
            account: "acct",
            credits: 9,
            ref: "job",
            idempotencyKey: "s",
          },
          tx,
        ),
      (err: unknown) => err instanceof InsufficientCredits,
    );
    await assert.rejects(
      () =>
        ledger.spend(
          {
            account: "acct",
            credits: 9,
            ref: "job",
            idempotencyKey: "s",
          },
          tx,
        ),
      (err: unknown) => err instanceof InsufficientCredits,
    );
    const ok = await ledger.spend(
      {
        account: "acct",
        credits: 2,
        ref: "job",
        idempotencyKey: "s-ok",
      },
      tx,
    );
    assert.equal(ok.replayed, false);
    assert.equal(ok.balance, 2);
  });
  assert.equal(await ledger.balance("acct"), 2);
});
