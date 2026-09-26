# KE Credits

A prepaid-credits ledger for AI products. You run it in your own Postgres. Customers buy credit packs through Stripe Checkout. Your product spends those credits inside the same database transaction as the work, so a balance cannot go below zero, even under concurrent requests. Refunds and lost disputes claw credits back. Every operation is idempotent: a retried request with the same inputs replays its stored result.

KE Credits is a library. It is not a hosted service. It holds no money. It records closed-loop, non-cash credits for an operator's own services.

## Status and limitations

**0.x, experimental.** It has a real Postgres test suite, but no external audit and little production volume yet. Read [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md) before you take real money with it.

- Single-entry ledger: balances are the sum of append-only entries. It is not a double-entry accounting system.
- Stripe is the only payment adapter. Each pack has one currency.
- Tax, invoicing and revenue recognition are yours; they are not modeled.
- Live Stripe keys are refused until you opt in (`allowLive: true` or `KE_CREDITS_ALLOW_LIVE=1`).

## Why

Invoice-time settlement records usage after the work is done and collects later. KE Credits debits in real time, in the same `Db.transaction` as the work. If `Ledger.spend` throws `InsufficientCredits`, the surrounding transaction does not commit the work. If the work rolls back, the spend rolls back with it.

## Install

```bash
npm install github:willykeenan/ke-credits
```

It is not on the npm registry yet. Installing from GitHub builds `dist/` on install.

Node 20 or newer. Zero runtime dependencies. Stripe is called with `fetch` against its REST API. Webhook signatures are verified with `node:crypto` HMAC.

Plug in any driver that implements `Db` / `Sql` (`pg`, postgres.js, PGlite, Neon):

```ts
export interface Sql {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}
```

## Quickstart

```ts
import { migrate, Ledger } from 'ke-credits';

await migrate(db);

const ledger = new Ledger(db);
await ledger.createAccount('acct_user_1');

await ledger.grant({
  account: 'acct_user_1',
  credits: 100,
  ref: 'welcome',
  idempotencyKey: 'welcome-acct_user_1',
});

await db.transaction(async (tx) => {
  const { entryId, balance, replayed } = await ledger.spend(
    {
      account: 'acct_user_1',
      credits: 3,
      ref: 'job_42',
      idempotencyKey: 'job_42',
    },
    tx,
  );
  await tx.query('insert into jobs (id, account, entry_id) values ($1, $2, $3)', [
    'job_42',
    'acct_user_1',
    entryId,
  ]);
  return { balance, replayed };
});
```

`migrate` is idempotent. It refuses to continue if an already-applied migration's checksum has drifted. `MIGRATIONS` is the ordered list; the same SQL also ships as `sql/*.sql`.

The same `idempotencyKey` with the same inputs returns the stored `Result` with `replayed: true`. The same key with different inputs throws `IdempotencyConflict`. Results live in `credits_operation_results`.

`Ledger.spend` throws `InsufficientCredits` when the balance is too low (the balance is unchanged) and `AccountSuspended` when the account is suspended.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `Sql` | interface | `query(text, params?)` |
| `Db` | interface | `Sql` plus `transaction(fn)` |
| `MIGRATIONS` | const | Ordered `{ id, sql }[]`; also shipped as `sql/*.sql` |
| `migrate` | function | Apply migrations; idempotent; refuses checksum drift |
| `Entry` | type | `{ id, account, delta, kind, ref, meta, at }` |
| `Ledger` | class | Append-only credits ledger |
| `Result` | type | `{ entryId, balance, replayed }` |
| `Holds` | class | Reserve / settle / release / expire for long-running jobs |
| `Pack` | type | `{ id, credits, amount, currency, label? }` |
| `definePacks` | function | Validate packs (positive integers, unique ids) |
| `createTopUpCheckout` | function | Stripe Checkout Session for a pack |
| `verifyStripeSignature` | function | HMAC-verify a webhook payload; throws on a bad or old signature |
| `handleStripeEvent` | function | Grant, clawback, suspend, unsuspend from Stripe events |
| `InsufficientCredits` | error | Thrown by `Ledger.spend` when `balance < credits` |
| `AccountSuspended` | error | Thrown by `Ledger.spend` on a suspended account |
| `IdempotencyConflict` | error | Same `idempotencyKey`, different inputs |

### `Ledger`

```ts
const ledger = new Ledger(db, { now: () => new Date() });

await ledger.createAccount(id, meta?);          // idempotent
await ledger.balance(account);                  // integer credits
await ledger.history(account, { limit?, before? });

await ledger.grant({ account, credits, ref, idempotencyKey, meta? });
await ledger.spend({ account, credits, ref, idempotencyKey, meta? }, tx?);
await ledger.refund({ account, spendEntryId, credits?, idempotencyKey, reason? });
await ledger.clawback({ account, purchaseRef, fraction, idempotencyKey, reason });

await ledger.suspend(account, reason);
await ledger.unsuspend(account);
await ledger.setDisputeStatus(account, disputeId, 'open' | 'won' | 'lost' | 'closed');
```

`Entry.kind` is one of `grant`, `spend`, `refund`, `clawback`, `adjust`, `expire`, `reverse`. Entries are append-only: the schema refuses `UPDATE` and `DELETE` on them.

`Ledger.refund` credits back at most the original spend (`spendEntryId`). `Ledger.clawback` removes a fraction of the credits granted by a purchase (`purchaseRef`). It never drives the balance negative; leftover obligation is recorded as `debt` in `meta`, and the account is suspended.

### `Holds`

For work that starts now and finishes later (a generation job, a batch). Reserved credits are unavailable until they are settled, released, or expired.

```ts
import { Holds } from 'ke-credits';

const holds = new Holds(db, ledger, { defaultTtlSeconds: 600 });

const { holdId, available } = await holds.reserve({
  account: 'acct_user_1',
  credits: 10,
  ref: 'job_42',
  idempotencyKey: 'hold:job_42',
  ttlSeconds: 600,
});

await holds.settle({ holdId, credits: 7, idempotencyKey: 'settle:job_42' });
// credits <= reserved; remainder becomes available. Returns Result.
```

`Holds.release` returns the whole reservation instead of settling. `Holds.expireDue` releases expired holds and returns how many it released. `Holds.available` is balance minus active holds. A second `Holds.settle` on the same hold is refused.

## Stripe

Test mode is the default. `createTopUpCheckout` refuses `sk_live_` and `rk_live_` keys unless `allowLive === true` or the environment variable `KE_CREDITS_ALLOW_LIVE=1` is set.

```ts
import { definePacks, createTopUpCheckout, verifyStripeSignature, handleStripeEvent } from 'ke-credits';

const packs = definePacks([
  { id: 'pack_a', credits: 250, amount: 2000, currency: 'usd', label: 'Pack A' },
  { id: 'pack_b', credits: 1200, amount: 9000, currency: 'usd', label: 'Pack B' },
]);

const { id, url } = await createTopUpCheckout({
  secretKey,
  pack: packs[0],
  account: 'acct_user_1',
  successUrl: 'https://example.com/credits/ok',
  cancelUrl: 'https://example.com/credits/cancel',
  fetchImpl: fetch,   // optional
  allowLive: false,
});
```

Checkout sets `client_reference_id` to the account, and metadata `{ ke_credits_pack, ke_credits_account }` on both the session and its PaymentIntent, so charges, refunds and disputes identify their account.

```ts
const event = verifyStripeSignature(payload, header, webhookSecret /*, toleranceSeconds */);
const { handled, action } = await handleStripeEvent(event, { ledger, packs });
```

`verifyStripeSignature` needs the raw bytes Stripe signed (`req.text()` in the App Router; `express.raw({ type: 'application/json' })` on the Express path).

| Event | Action |
| --- | --- |
| `checkout.session.completed` with `payment_status=paid` | `Ledger.grant` of the pack's credits. `idempotencyKey` is the event id / session id |
| `charge.refunded` | Proportional `Ledger.clawback` of that purchase |
| `charge.dispute.created` | `Ledger.setDisputeStatus(open)`: spending is suspended while any dispute is open |
| `charge.dispute.closed` lost | `Ledger.clawback` of the disputed share, then the dispute is closed |
| `charge.dispute.closed` won (or an inquiry closed) | The dispute is closed; the suspension lifts when no dispute is still open |
| anything else | `{ handled: false }` |

Every handler is idempotent on `event.id`, and safe in any delivery order: Stripe does not order webhooks. A dispute's closing status is terminal, so a "won" that arrives before its "created" never suspends. Lifting a dispute suspension never clears one you or a clawback debt set. When `handleStripeEvent` throws (for example, a refund that arrives before its purchase was granted), return a 5xx so Stripe retries; the retry succeeds once the grant exists.

Copy-paste route handlers: [`examples/nextjs-route.ts`](examples/nextjs-route.ts) and [`examples/express.ts`](examples/express.ts). Concepts and a 20-line integration: [`docs/GUIDE.md`](docs/GUIDE.md). Threat model: [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md).

## Legal

KE Credits is software, not a payment processor, money transmitter, bank or stored-value issuer. It holds no funds. It records closed-loop, non-cash credits for an operator's own services. Operators are responsible for tax, consumer-protection, unclaimed-property, prepaid-access and PCI compliance.

Apache-2.0. Copyright KE Studios. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
