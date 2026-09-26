import assert from "node:assert/strict";
import test from "node:test";
import { InsufficientCredits } from "../src/errors.ts";
import { Ledger } from "../src/ledger.ts";
import { migrate } from "../src/schema.ts";
import { pgliteDb } from "./helpers.ts";

test("50 concurrent spends never drive the balance negative", async () => {
  const db = await pgliteDb();
  await migrate(db);
  const ledger = new Ledger(db);
  await ledger.createAccount("acct");
  await ledger.grant({
    account: "acct",
    credits: 10,
    ref: "pack",
    idempotencyKey: "grant-10",
  });

  const results = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      ledger.spend({
        account: "acct",
        credits: 1,
        ref: `job-${i}`,
        idempotencyKey: `spend-${i}`,
      }),
    ),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 10);
  assert.equal(rejected.length, 40);
  for (const r of rejected) {
    assert.ok(r.status === "rejected");
    assert.ok(r.reason instanceof InsufficientCredits);
  }
  const balances = fulfilled.map((r) => {
    assert.ok(r.status === "fulfilled");
    return r.value.balance;
  });
  assert.ok(balances.every((b) => b >= 0));
  assert.equal(await ledger.balance("acct"), 0);
  const history = await ledger.history("acct", { limit: 100 });
  const spends = history.filter((e) => e.kind === "spend");
  assert.equal(spends.length, 10);
  const sum = history.reduce((acc, e) => acc + e.delta, 0);
  assert.equal(sum, 0);
  assert.ok(sum >= 0);
});
