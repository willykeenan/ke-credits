# KE Credits guide

KE Credits is a library you run against your own Postgres. It records integer credits on an append-only ledger. Money movement, if any, happens in your Stripe account. The ledger holds no funds.

## Concepts

**Account.** An operator-chosen string (`acct_user_1`). `Ledger.createAccount` is idempotent.

**Entry.** One append-only row: `{ id, account, delta, kind, ref, meta, at }`. `kind` is `grant`, `spend`, `refund`, `clawback`, `adjust`, `expire`, or `reverse`. The schema refuses `UPDATE` and `DELETE` on entries.

**Balance.** The sum of `delta` for an account. `Ledger.spend` will not take the balance below zero. Under concurrency the debit runs inside a database transaction (yours, via the optional `tx` argument, or the ledger's).

**Idempotency.** Every mutating call takes `idempotencyKey`. The same key and the same inputs return the stored `Result` with `replayed: true`. The same key and different inputs throw `IdempotencyConflict`. Stored in `credits_operation_results`.

**Grant / spend / refund / clawback.** `Ledger.grant` adds credits (a purchase, a welcome bonus). `Ledger.spend` removes them and throws `InsufficientCredits` or `AccountSuspended` without changing the balance. `Ledger.refund` returns credits against a specific `spendEntryId`, limited to that spend. `Ledger.clawback` removes a `fraction` of the credits granted by `purchaseRef`. It never drives the balance negative; leftover obligation is `debt` in `meta`, and the account is suspended.

**Holds.** `Holds.reserve` sets credits aside for a long-running job. `Holds.available` is balance minus active holds. `Holds.settle` spends `credits <= reserved` and releases the rest. `Holds.release` returns the reservation. `Holds.expireDue` releases holds past their TTL. A second settle is refused.

**Packs.** `definePacks` validates `{ id, credits, amount, currency, label? }` (positive integers, unique ids). `amount` is the Stripe amount in the currency's smallest unit.

**Stripe adapter.** `createTopUpCheckout` opens a Checkout Session (`client_reference_id` = account; metadata `ke_credits_pack` and `ke_credits_account` on the session and its PaymentIntent). `verifyStripeSignature` checks the HMAC. `handleStripeEvent` grants on paid checkout, claws back on refund, suspends while a dispute is open, claws back the disputed share on a lost dispute, and lifts the dispute suspension when no dispute is still open. It is safe in any delivery order; if it throws, answer 5xx so Stripe retries. Live secret keys are refused until you set `allowLive: true` or `KE_CREDITS_ALLOW_LIVE=1`.

## Integration in 20 lines

```ts
import { migrate, Ledger } from 'ke-credits';

await migrate(db);
const ledger = new Ledger(db);
await ledger.createAccount(accountId);

await db.transaction(async (tx) => {
  const { entryId } = await ledger.spend(
    { account: accountId, credits: cost, ref: jobId, idempotencyKey: jobId },
    tx,
  );
  await tx.query('insert into jobs (id, account, entry_id) values ($1, $2, $3)', [
    jobId,
    accountId,
    entryId,
  ]);
});
```

If `Ledger.spend` throws, the `insert into jobs` does not commit.

## Top-up with Stripe

```ts
import { definePacks, createTopUpCheckout, verifyStripeSignature, handleStripeEvent } from 'ke-credits';

const packs = definePacks([
  { id: 'pack_a', credits: 250, amount: 2000, currency: 'usd' },
]);

const session = await createTopUpCheckout({
  secretKey,
  pack: packs[0],
  account: accountId,
  successUrl: 'https://example.com/credits/ok',
  cancelUrl: 'https://example.com/credits/cancel',
});

const event = verifyStripeSignature(payload, header, webhookSecret);
await handleStripeEvent(event, { ledger, packs });
```

## Long-running jobs

```ts
import { Holds } from 'ke-credits';

const holds = new Holds(db, ledger, { defaultTtlSeconds: 900 });
const { holdId } = await holds.reserve({
  account: accountId,
  credits: 10,
  ref: jobId,
  idempotencyKey: `hold:${jobId}`,
});
// do the work
await holds.settle({ holdId, credits: actual, idempotencyKey: `settle:${jobId}` });
```

Call `Holds.expireDue` from a periodic job.

## Examples

- Next.js App Router webhook: [`examples/nextjs-route.ts`](../examples/nextjs-route.ts)
- Express webhook: [`examples/express.ts`](../examples/express.ts)

`verifyStripeSignature` needs the raw bytes Stripe signed. Next.js App Router: `req.text()`. Express: `express.raw({ type: 'application/json' })` on that path, not `express.json()`.

Wire `db` with your driver. The library talks to Postgres only through `Db` / `Sql`.
