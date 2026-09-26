# KE Credits API

The exported surface. Everything below is re-exported from the package root; errors are in `src/errors.ts`.

## Public API (`src/index.ts` re-exports)

```ts
// src/schema.ts
export const MIGRATIONS: { id: string; sql: string }[]          // ordered; also shipped as sql/*.sql
export async function migrate(db: Db): Promise<{ applied: string[] }>   // idempotent; refuses if an applied migration's checksum drifted

// src/ledger.ts
export type Entry = { id: string; account: string; delta: number; kind: 'grant'|'spend'|'refund'|'clawback'|'adjust'|'expire'|'reverse';
                      ref: string | null; meta: Record<string, unknown>; at: string };
export class Ledger {
  constructor(db: Db, opts?: { now?: () => Date });
  createAccount(id: string, meta?: Record<string, unknown>): Promise<void>;          // idempotent
  balance(account: string): Promise<number>;                                          // integer credits
  history(account: string, opts?: { limit?: number; before?: string }): Promise<Entry[]>;
  grant(input: { account: string; credits: number; ref: string; idempotencyKey: string; meta?: object }): Promise<Result>;
  spend(input: { account: string; credits: number; ref: string; idempotencyKey: string; meta?: object }, tx?: Sql): Promise<Result>;
      // atomic; throws InsufficientCredits (balance unchanged) when balance < credits; a suspended account throws AccountSuspended
  refund(input: { account: string; spendEntryId: string; credits?: number; idempotencyKey: string; reason?: string }): Promise<Result>;
  clawback(input: { account: string; purchaseRef: string; fraction: number; idempotencyKey: string; reason: string }): Promise<Result>;
      // proportional removal of credits granted by a purchase (cumulative per purchase, so refunds and a lost
      // dispute never take more than was granted); never drives balance negative -> records 'debt' in meta and suspends
  suspend(account: string, reason: string): Promise<void>;
  unsuspend(account: string): Promise<void>;
  setDisputeStatus(account: string, disputeId: string, status: 'open'|'won'|'lost'|'closed'): Promise<{ suspended: boolean }>;
      // suspended while any dispute is open; a closing status is terminal (safe in any delivery order);
      // lifts only a suspension that disputes caused
}
export type Result = { entryId: string; balance: number; replayed: boolean };
// Idempotency: the same idempotencyKey with the same inputs returns the stored Result (replayed:true);
// the same key with different inputs throws IdempotencyConflict. Results are stored in credits_operation_results.

// src/holds.ts  (reserve -> settle/release/expire, for long-running jobs)
export class Holds {
  constructor(db: Db, ledger: Ledger, opts?: { now?: () => Date; defaultTtlSeconds?: number });
  reserve(input: { account: string; credits: number; ref: string; idempotencyKey: string; ttlSeconds?: number }): Promise<{ holdId: string; available: number }>;
  settle(input: { holdId: string; credits: number; idempotencyKey: string }): Promise<Result>;   // credits <= reserved; remainder released
  release(input: { holdId: string; idempotencyKey: string }): Promise<{ released: number }>;
  expireDue(): Promise<number>;                                                                    // releases expired holds
  available(account: string): Promise<number>;                                                     // balance minus active holds
}

// src/packs.ts
export type Pack = { id: string; credits: number; amount: number; currency: string; label?: string };
export function definePacks(packs: Pack[]): Pack[];   // validates (positive integers, unique ids)

// src/stripe/checkout.ts
export async function createTopUpCheckout(opts: {
  secretKey: string; pack: Pack; account: string; successUrl: string; cancelUrl: string;
  fetchImpl?: typeof fetch; allowLive?: boolean;
}): Promise<{ id: string; url: string }>;
  // refuses sk_live_/rk_live_ keys unless allowLive === true (or env KE_CREDITS_ALLOW_LIVE=1); client_reference_id = account; metadata {ke_credits_pack, ke_credits_account}
  // on the session and on its PaymentIntent (so charges, refunds and disputes carry it)

// src/stripe/webhooks.ts
export function verifyStripeSignature(payload: string | Buffer, header: string, secret: string, toleranceSeconds?: number): object;  // throws on bad/old signature
export async function handleStripeEvent(event: any, deps: { ledger: Ledger; packs: Pack[] }): Promise<{ handled: boolean; action: string }>;
  // checkout.session.completed (payment_status=paid) -> grant pack credits (idempotencyKey = event.id / session id)
  // charge.refunded -> proportional clawback of that purchase's credits (throws if the grant does not exist yet: answer 5xx, Stripe retries)
  // charge.dispute.created -> setDisputeStatus(open); closed lost -> clawback of the disputed share, then lost;
  // closed won / warning_closed -> won; any other closing status -> closed
  // unknown events -> {handled:false}; every handler idempotent on event.id and safe in any delivery order
export type StripeEventResult = { handled: boolean; action: string };
```
