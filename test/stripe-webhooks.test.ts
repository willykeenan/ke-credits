import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AccountSuspended } from "../src/errors.ts";
import { Ledger } from "../src/ledger.ts";
import { definePacks } from "../src/packs.ts";
import { migrate } from "../src/schema.ts";
import {
  handleStripeEvent,
  verifyStripeSignature,
} from "../src/stripe/webhooks.ts";
import { pgliteDb } from "./helpers.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SECRET = "whsec_test_ke_credits_webhook";
const ACCOUNT = "acct_user_1";

const PACKS = definePacks([
  { id: "pack_a", credits: 250, amount: 2000, currency: "usd", label: "Pack A" },
  { id: "pack_b", credits: 1200, amount: 9000, currency: "usd", label: "Pack B" },
]);

function loadRaw(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function loadEvent(name: string): any {
  return JSON.parse(loadRaw(name));
}

function sign(
  payload: string,
  secret = SECRET,
  ts = Math.floor(Date.now() / 1000),
): { header: string; timestamp: number; v1: string } {
  const v1 = createHmac("sha256", secret).update(`${ts}.${payload}`, "utf8").digest("hex");
  return { header: `t=${ts},v1=${v1}`, timestamp: ts, v1 };
}

async function fresh() {
  const db = await pgliteDb();
  await migrate(db);
  const ledger = new Ledger(db);
  return { db, ledger, packs: PACKS };
}

async function grantPaidCheckout(ledger: Ledger) {
  return handleStripeEvent(loadEvent("checkout.session.completed.json"), {
    ledger,
    packs: PACKS,
  });
}

async function assertSuspended(ledger: Ledger) {
  await assert.rejects(
    () =>
      ledger.spend({
        account: ACCOUNT,
        credits: 1,
        ref: "blocked",
        idempotencyKey: `blocked:${Date.now()}:${Math.random()}`,
      }),
    (err: unknown) => err instanceof AccountSuspended,
  );
}

function unexpandedDispute(event: any) {
  const copy = structuredClone(event);
  const obj = copy.data.object;
  if (obj.charge && typeof obj.charge === "object") {
    obj.charge = obj.charge.id;
  }
  delete obj.metadata;
  return copy;
}

function stripChargeMetadata(event: any) {
  const copy = structuredClone(event);
  delete copy.data.object.metadata;
  return copy;
}

test("verifyStripeSignature accepts a valid t= v1= HMAC", () => {
  const payload = loadRaw("checkout.session.completed.json");
  const { header } = sign(payload);
  const event = verifyStripeSignature(payload, header, SECRET);
  assert.equal((event as { id: string }).id, "evt_test_checkout_paid_1");
  assert.equal((event as { type: string }).type, "checkout.session.completed");
});

test("verifyStripeSignature accepts a Buffer payload", () => {
  const payload = loadRaw("customer.updated.json");
  const { header } = sign(payload);
  const event = verifyStripeSignature(Buffer.from(payload, "utf8"), header, SECRET);
  assert.equal((event as { id: string }).id, "evt_test_customer_updated_1");
});

test("verifyStripeSignature rejects a tampered payload", () => {
  const payload = loadRaw("checkout.session.completed.json");
  const { header } = sign(payload);
  const tampered = payload.replace("acct_user_1", "acct_user_evil");
  assert.throws(
    () => verifyStripeSignature(tampered, header, SECRET),
    (err: unknown) => err instanceof Error && /signature/i.test(err.message),
  );
});

test("verifyStripeSignature rejects an old timestamp", () => {
  const payload = loadRaw("checkout.session.completed.json");
  const old = Math.floor(Date.now() / 1000) - 301;
  const { header } = sign(payload, SECRET, old);
  assert.throws(
    () => verifyStripeSignature(payload, header, SECRET),
    (err: unknown) => err instanceof Error && /tolerance/i.test(err.message),
  );
});

test("verifyStripeSignature rejects a timestamp too far in the future", () => {
  const payload = loadRaw("checkout.session.completed.json");
  const future = Math.floor(Date.now() / 1000) + 301;
  const { header } = sign(payload, SECRET, future);
  assert.throws(
    () => verifyStripeSignature(payload, header, SECRET),
    (err: unknown) => err instanceof Error && /tolerance/i.test(err.message),
  );
});

test("verifyStripeSignature accepts a timestamp within the 300s tolerance", () => {
  const payload = loadRaw("checkout.session.completed.json");
  const edge = Math.floor(Date.now() / 1000) - 299;
  const { header } = sign(payload, SECRET, edge);
  const event = verifyStripeSignature(payload, header, SECRET);
  assert.equal((event as { id: string }).id, "evt_test_checkout_paid_1");
});

test("verifyStripeSignature accepts any matching v1 among several", () => {
  const payload = loadRaw("charge.refunded.json");
  const ts = Math.floor(Date.now() / 1000);
  const good = sign(payload, SECRET, ts).v1;
  const bad = sign(payload, "whsec_wrong_secret", ts).v1;
  const header = `t=${ts},v1=${bad},v1=${good}`;
  const event = verifyStripeSignature(payload, header, SECRET);
  assert.equal((event as { id: string }).id, "evt_test_charge_refunded_full_1");
});

test("verifyStripeSignature rejects when none of the v1 signatures match", () => {
  const payload = loadRaw("charge.refunded.json");
  const ts = Math.floor(Date.now() / 1000);
  const bad1 = sign(payload, "whsec_wrong_a", ts).v1;
  const bad2 = sign(payload, "whsec_wrong_b", ts).v1;
  assert.throws(() =>
    verifyStripeSignature(payload, `t=${ts},v1=${bad1},v1=${bad2}`, SECRET),
  );
});

test("verifyStripeSignature rejects a missing header, secret, or t=/v1=", () => {
  const payload = "{}";
  assert.throws(() => verifyStripeSignature(payload, "", SECRET));
  assert.throws(() => verifyStripeSignature(payload, "t=1,v1=abcd", ""));
  assert.throws(() => verifyStripeSignature(payload, "v1=abcd", SECRET));
  assert.throws(() => verifyStripeSignature(payload, "t=1", SECRET));
});

test("checkout.session.completed (paid) grants pack credits and is idempotent on redelivery", async () => {
  const { ledger } = await fresh();
  const event = loadEvent("checkout.session.completed.json");
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "grant" });
  assert.equal(await ledger.balance(ACCOUNT), 250);
  const history = await ledger.history(ACCOUNT);
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "grant");
  assert.equal(history[0].delta, 250);
  assert.equal(history[0].ref, "pi_test_ke_credits_1");

  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "grant" });
  assert.equal(await ledger.balance(ACCOUNT), 250);
  assert.equal((await ledger.history(ACCOUNT)).length, 1);
});

test("checkout.session.completed unpaid does not grant, and redelivery stays pending", async () => {
  const { ledger } = await fresh();
  const event = loadEvent("checkout.session.completed.unpaid.json");
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "pending" });
  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "pending" });
  await ledger.createAccount(ACCOUNT);
  assert.equal(await ledger.balance(ACCOUNT), 0);
});

test("charge.refunded claws back proportionally and is idempotent on redelivery", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  const partial = loadEvent("charge.refunded.partial.json");
  const first = await handleStripeEvent(partial, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 125);
  const replay = await handleStripeEvent(partial, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 125);
  const claws = (await ledger.history(ACCOUNT)).filter((e) => e.kind === "clawback");
  assert.equal(claws.length, 1);
  assert.equal(claws[0].delta, -125);
  assert.equal(claws[0].ref, "pi_test_ke_credits_1");
});

test("charge.refunded full clawback after spend records debt and is idempotent", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  await ledger.spend({
    account: ACCOUNT,
    credits: 200,
    ref: "job-1",
    idempotencyKey: "job-1",
  });
  const event = loadEvent("charge.refunded.json");
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 0);
  const claw = (await ledger.history(ACCOUNT)).find((e) => e.kind === "clawback");
  assert.ok(claw);
  assert.equal(claw!.delta, -50);
  assert.equal(claw!.meta.debt, 200);
  await assertSuspended(ledger);

  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 0);
  assert.equal((await ledger.history(ACCOUNT)).filter((e) => e.kind === "clawback").length, 1);
});

test("charge.dispute.created suspends spending and is idempotent on redelivery", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  const event = loadEvent("charge.dispute.created.json");
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "suspend" });
  await assertSuspended(ledger);
  assert.equal(await ledger.balance(ACCOUNT), 250);

  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "suspend" });
  await assertSuspended(ledger);
  assert.equal(await ledger.balance(ACCOUNT), 250);
});

test("charge.dispute.closed lost claws remaining credits and is idempotent on redelivery", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  await ledger.spend({
    account: ACCOUNT,
    credits: 40,
    ref: "pre-dispute-spend",
    idempotencyKey: "pre-dispute-spend",
  });
  await handleStripeEvent(loadEvent("charge.dispute.created.json"), {
    ledger,
    packs: PACKS,
  });
  const event = loadEvent("charge.dispute.closed.lost.json");
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 0);
  const claw = (await ledger.history(ACCOUNT)).find((e) => e.kind === "clawback");
  assert.ok(claw);
  assert.equal(claw!.delta, -210);
  assert.equal(claw!.meta.debt, 40);

  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 0);
  assert.equal((await ledger.history(ACCOUNT)).filter((e) => e.kind === "clawback").length, 1);
});

test("charge.dispute.closed won unsuspends and is idempotent on redelivery", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  await handleStripeEvent(loadEvent("charge.dispute.created.json"), {
    ledger,
    packs: PACKS,
  });
  await assertSuspended(ledger);

  const event = loadEvent("charge.dispute.closed.won.json");
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "unsuspend" });
  const spend = await ledger.spend({
    account: ACCOUNT,
    credits: 10,
    ref: "after-win",
    idempotencyKey: "after-win",
  });
  assert.equal(spend.balance, 240);

  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "unsuspend" });
  assert.equal(await ledger.balance(ACCOUNT), 240);
  const again = await ledger.spend({
    account: ACCOUNT,
    credits: 5,
    ref: "after-win-2",
    idempotencyKey: "after-win-2",
  });
  assert.equal(again.balance, 235);
});

test("unknown events return handled:false and stay that way on redelivery", async () => {
  const { ledger } = await fresh();
  const event = loadEvent("customer.updated.json");
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: false, action: "ignored" });
  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: false, action: "ignored" });
  await ledger.createAccount(ACCOUNT);
  assert.equal(await ledger.balance(ACCOUNT), 0);
});

test("non-credits checkout and refund events are ignored", async () => {
  const { ledger } = await fresh();
  const checkout = loadEvent("checkout.session.completed.json");
  delete checkout.data.object.metadata;
  checkout.data.object.client_reference_id = "someone-else";
  const ignoredCheckout = await handleStripeEvent(checkout, { ledger, packs: PACKS });
  assert.equal(ignoredCheckout.handled, false);

  const refund = loadEvent("charge.refunded.json");
  delete refund.data.object.metadata;
  const ignoredRefund = await handleStripeEvent(refund, { ledger, packs: PACKS });
  assert.equal(ignoredRefund.handled, false);
});

test("signed checkout fixture verifies then grants against a real Ledger", async () => {
  const { ledger } = await fresh();
  const payload = loadRaw("checkout.session.completed.json");
  const { header } = sign(payload);
  const event = verifyStripeSignature(payload, header, SECRET);
  const result = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(result, { handled: true, action: "grant" });
  assert.equal(await ledger.balance(ACCOUNT), 250);
});

test("checkout.session.async_payment_succeeded grants once with completed for the same session", async () => {
  const { ledger } = await fresh();
  const pending = loadEvent("checkout.session.async_payment_succeeded.json");
  pending.id = "evt_test_checkout_async_pending_1";
  pending.type = "checkout.session.completed";
  pending.data.object.payment_status = "unpaid";
  const unpaid = await handleStripeEvent(pending, { ledger, packs: PACKS });
  assert.deepEqual(unpaid, { handled: true, action: "pending" });

  const asyncPaid = loadEvent("checkout.session.async_payment_succeeded.json");
  const first = await handleStripeEvent(asyncPaid, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "grant" });
  assert.equal(await ledger.balance(ACCOUNT), 250);

  const replay = await handleStripeEvent(asyncPaid, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "grant" });
  assert.equal(await ledger.balance(ACCOUNT), 250);

  const paidCompleted = loadEvent("checkout.session.completed.json");
  const secondEvent = await handleStripeEvent(paidCompleted, { ledger, packs: PACKS });
  assert.deepEqual(secondEvent, { handled: true, action: "grant" });
  assert.equal(await ledger.balance(ACCOUNT), 250);
  assert.equal((await ledger.history(ACCOUNT)).filter((e) => e.kind === "grant").length, 1);
});

test("charge.refunded successive events claw back from cumulative amount_refunded", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  const partial = await handleStripeEvent(loadEvent("charge.refunded.partial.json"), {
    ledger,
    packs: PACKS,
  });
  assert.deepEqual(partial, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 125);
  const full = await handleStripeEvent(loadEvent("charge.refunded.json"), {
    ledger,
    packs: PACKS,
  });
  assert.deepEqual(full, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 0);
  const claws = (await ledger.history(ACCOUNT)).filter((e) => e.kind === "clawback");
  assert.equal(claws.length, 2);
  assert.equal(
    claws.reduce((sum, entry) => sum + entry.delta, 0),
    -250,
  );
});

test("unexpanded charge.refunded still claws back via the payment_intent grant", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  const event = stripChargeMetadata(loadEvent("charge.refunded.partial.json"));
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 125);
  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 125);
});

test("unexpanded charge.dispute.created suspends via the payment_intent grant", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  const event = unexpandedDispute(loadEvent("charge.dispute.created.json"));
  assert.equal(typeof event.data.object.charge, "string");
  assert.equal(event.data.object.metadata, undefined);
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "suspend" });
  await assertSuspended(ledger);
  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "suspend" });
  await assertSuspended(ledger);
});

test("unexpanded charge.dispute.closed lost claws back via the payment_intent grant", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  const created = unexpandedDispute(loadEvent("charge.dispute.created.json"));
  await handleStripeEvent(created, { ledger, packs: PACKS });
  const event = unexpandedDispute(loadEvent("charge.dispute.closed.lost.json"));
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "clawback" });
  assert.equal(await ledger.balance(ACCOUNT), 0);
  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "clawback" });
  assert.equal((await ledger.history(ACCOUNT)).filter((e) => e.kind === "clawback").length, 1);
});

test("unexpanded charge.dispute.closed won unsuspends via the payment_intent grant", async () => {
  const { ledger } = await fresh();
  await grantPaidCheckout(ledger);
  await handleStripeEvent(unexpandedDispute(loadEvent("charge.dispute.created.json")), {
    ledger,
    packs: PACKS,
  });
  await assertSuspended(ledger);
  const event = unexpandedDispute(loadEvent("charge.dispute.closed.won.json"));
  const first = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(first, { handled: true, action: "unsuspend" });
  const spend = await ledger.spend({
    account: ACCOUNT,
    credits: 10,
    ref: "after-unexpanded-win",
    idempotencyKey: "after-unexpanded-win",
  });
  assert.equal(spend.balance, 240);
  const replay = await handleStripeEvent(event, { ledger, packs: PACKS });
  assert.deepEqual(replay, { handled: true, action: "unsuspend" });
});

// --- Delivery order. Stripe does not order webhook events. ---------------

function disputeEvent(file: string, disputeId: string, eventId: string, patch: Record<string, unknown> = {}) {
  const event = structuredClone(loadEvent(file));
  event.id = eventId;
  event.data.object.id = disputeId;
  Object.assign(event.data.object, patch);
  return event;
}

async function suspendedReason(db: any): Promise<string | null> {
  const res = await db.query("SELECT suspended_at, suspended_reason FROM credits_accounts WHERE id = $1", [ACCOUNT]);
  return res.rows[0]?.suspended_at ? String(res.rows[0].suspended_reason) : null;
}

test("a won dispute delivered before its created event never suspends", async () => {
  const { db, ledger, packs } = await fresh();
  await grantPaidCheckout(ledger);
  const won = disputeEvent("charge.dispute.closed.won.json", "dp_order_1", "evt_order_won");
  const created = disputeEvent("charge.dispute.created.json", "dp_order_1", "evt_order_created");
  assert.equal((await handleStripeEvent(won, { ledger, packs })).action, "unsuspend");
  await handleStripeEvent(created, { ledger, packs });
  await handleStripeEvent(created, { ledger, packs });
  assert.equal(await suspendedReason(db), null);
  const spent = await ledger.spend({ account: ACCOUNT, credits: 1, ref: "after-win", idempotencyKey: "after-win" });
  assert.equal(spent.balance, 249);
});

test("one won dispute does not lift a suspension another open dispute holds", async () => {
  const { db, ledger, packs } = await fresh();
  await grantPaidCheckout(ledger);
  await handleStripeEvent(disputeEvent("charge.dispute.created.json", "dp_a", "evt_a_created"), { ledger, packs });
  await handleStripeEvent(disputeEvent("charge.dispute.created.json", "dp_b", "evt_b_created"), { ledger, packs });
  await handleStripeEvent(disputeEvent("charge.dispute.closed.won.json", "dp_a", "evt_a_won"), { ledger, packs });
  await assertSuspended(ledger);
  await handleStripeEvent(disputeEvent("charge.dispute.closed.won.json", "dp_b", "evt_b_won"), { ledger, packs });
  assert.equal(await suspendedReason(db), null);
});

test("a won dispute never lifts a suspension the operator set", async () => {
  const { db, ledger, packs } = await fresh();
  await grantPaidCheckout(ledger);
  await ledger.suspend(ACCOUNT, "operator: manual review");
  await handleStripeEvent(disputeEvent("charge.dispute.created.json", "dp_op", "evt_op_created"), { ledger, packs });
  await handleStripeEvent(disputeEvent("charge.dispute.closed.won.json", "dp_op", "evt_op_won"), { ledger, packs });
  assert.equal(await suspendedReason(db), "operator: manual review");
});

test("a lost dispute delivered before its created event claws back once and does not suspend", async () => {
  const { db, ledger, packs } = await fresh();
  await grantPaidCheckout(ledger);
  const lost = disputeEvent("charge.dispute.closed.lost.json", "dp_lost_first", "evt_lost_first");
  assert.equal((await handleStripeEvent(lost, { ledger, packs })).action, "clawback");
  await handleStripeEvent(disputeEvent("charge.dispute.created.json", "dp_lost_first", "evt_lost_created"), { ledger, packs });
  assert.equal(await suspendedReason(db), null);
  const balance = await db.query("SELECT COALESCE(SUM(delta), 0)::int AS b FROM credits_ledger WHERE account = $1", [ACCOUNT]);
  assert.equal(balance.rows[0].b, 0);
});

test("a partial dispute takes back only the disputed share", async () => {
  const { db, ledger, packs } = await fresh();
  await grantPaidCheckout(ledger);
  const lost = disputeEvent("charge.dispute.closed.lost.json", "dp_partial", "evt_partial_lost", { amount: 1000 });
  await handleStripeEvent(lost, { ledger, packs });
  const balance = await db.query("SELECT COALESCE(SUM(delta), 0)::int AS b FROM credits_ledger WHERE account = $1", [ACCOUNT]);
  assert.equal(balance.rows[0].b, 125, "half the charge disputed -> half of 250 credits");
});

test("concurrent created / won / created deliveries converge to not suspended", async () => {
  const { db, ledger, packs } = await fresh();
  await grantPaidCheckout(ledger);
  await Promise.all([
    handleStripeEvent(disputeEvent("charge.dispute.created.json", "dp_race", "evt_race_1"), { ledger, packs }),
    handleStripeEvent(disputeEvent("charge.dispute.closed.won.json", "dp_race", "evt_race_2"), { ledger, packs }),
    handleStripeEvent(disputeEvent("charge.dispute.created.json", "dp_race", "evt_race_3"), { ledger, packs }),
  ]);
  assert.equal(await suspendedReason(db), null);
});

test("a refund delivered before its grant fails (so Stripe retries) and applies once the grant exists", async () => {
  const { db, ledger, packs } = await fresh();
  await ledger.createAccount(ACCOUNT);
  const refund = structuredClone(loadEvent("charge.refunded.json"));
  refund.data.object.metadata = { ke_credits_pack: "pack_a", ke_credits_account: ACCOUNT };
  await assert.rejects(() => handleStripeEvent(refund, { ledger, packs }));
  await grantPaidCheckout(ledger);
  assert.equal((await handleStripeEvent(refund, { ledger, packs })).action, "clawback");
  const balance = await db.query("SELECT COALESCE(SUM(delta), 0)::int AS b FROM credits_ledger WHERE account = $1", [ACCOUNT]);
  assert.equal(balance.rows[0].b, 0);
});
