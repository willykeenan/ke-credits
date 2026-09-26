// A two-minute tour on a real Postgres engine (PGlite, in memory): buy a pack
// through a signed Stripe webhook, spend inside a transaction, refuse an
// overdraft, retry safely, refund, then let a refund claw credits back.
// Run: npx tsx examples/demo.ts
import { createHmac } from "node:crypto";
import { Ledger, definePacks, migrate, handleStripeEvent, verifyStripeSignature, InsufficientCredits } from "../src/index.ts";
import { pgliteDb } from "../test/helpers.ts";

const say = (label: string, value: unknown) => console.log(`${label.padEnd(34)} ${value}`);
const db = await pgliteDb();
await migrate(db);
const ledger = new Ledger(db);
const packs = definePacks([{ id: "starter", credits: 500, amount: 1000, currency: "usd", label: "Starter" }]);
await ledger.createAccount("acct_ada");

// 1. Stripe says a Checkout Session was paid. Verify the signature, then grant.
const secret = "whsec_demo_only";
const checkout = { id: "evt_demo_1", type: "checkout.session.completed", data: { object: {
  id: "cs_demo_1", mode: "payment", payment_status: "paid", amount_total: 1000, currency: "usd", payment_intent: "pi_demo_1",
  metadata: { ke_credits_pack: "starter", ke_credits_account: "acct_ada" } } } };
const body = JSON.stringify(checkout);
const t = Math.floor(Date.now() / 1000);
const header = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const event = verifyStripeSignature(body, header, secret);
say("webhook checkout.session.completed", JSON.stringify(await handleStripeEvent(event, { ledger, packs })));
say("balance after purchase", await ledger.balance("acct_ada"));

// 2. Spend inside the same transaction as the work.
const job = await ledger.spend({ account: "acct_ada", credits: 120, ref: "render-42", idempotencyKey: "job-42" });
say("spend 120 for render-42", `balance ${job.balance}`);
const retry = await ledger.spend({ account: "acct_ada", credits: 120, ref: "render-42", idempotencyKey: "job-42" });
say("retry the same request", `replayed=${retry.replayed}, balance ${retry.balance}`);
try {
  await ledger.spend({ account: "acct_ada", credits: 1000, ref: "render-43", idempotencyKey: "job-43" });
} catch (e) {
  say("spend 1000 (too much)", e instanceof InsufficientCredits ? "refused: InsufficientCredits, balance unchanged" : String(e));
}

// 3. The job failed: refund exactly what it spent.
const refund = await ledger.refund({ account: "acct_ada", spendEntryId: job.entryId, idempotencyKey: "refund-42" });
say("refund the failed render", `balance ${refund.balance}`);

// 4. Stripe refunds half the payment: half the pack is clawed back.
const refunded = { id: "evt_demo_2", type: "charge.refunded", data: { object: { id: "ch_demo_1", payment_intent: "pi_demo_1",
  amount: 1000, amount_refunded: 500, metadata: { ke_credits_pack: "starter", ke_credits_account: "acct_ada" } } } };
say("webhook charge.refunded (50%)", JSON.stringify(await handleStripeEvent(refunded, { ledger, packs })));
say("balance after clawback", await ledger.balance("acct_ada"));
say("history", (await ledger.history("acct_ada")).map((e) => `${e.kind}${e.delta > 0 ? "+" : ""}${e.delta}`).join("  "));
