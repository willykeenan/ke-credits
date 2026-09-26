# Security model

KE Credits is a ledger library. The operator owns the database, the Stripe account, the webhook endpoint, and the product that calls `Ledger.spend`. The library never sees card data, never holds funds, and never talks to a KE-hosted service.

## Trust boundaries

| Boundary | Who is trusted | What crosses it |
| --- | --- | --- |
| Operator database | The operator's Postgres and the `Db` adapter they pass in | SQL through `Sql.query` / `Db.transaction` |
| Operator process | The operator's Node process | Ledger calls, pack definitions, Stripe secret key |
| Stripe | Stripe Checkout and Stripe webhooks | Checkout Session create; signed webhook payloads |
| End user | Not trusted | They never call the ledger. They pay through Stripe Checkout. They consume the operator's product. |

The library's job on the Stripe side is to verify the webhook HMAC, refuse live keys until the operator opts in, and translate events into idempotent ledger calls.

## Ledger integrity

- **Append-only entries.** `UPDATE` and `DELETE` on ledger entries are refused by database rules or triggers. Corrections are new rows (`refund`, `clawback`, `reverse`, `adjust`, `expire`).
- **Non-negative spend.** `Ledger.spend` runs inside a transaction. When `balance < credits` it throws `InsufficientCredits` and leaves the balance unchanged. Concurrent spends serialize on the account row.
- **Caller transaction.** Passing `tx` into `Ledger.spend` joins the operator's transaction, so work and debit commit or roll back together.
- **Idempotency.** Results are stored in `credits_operation_results`. A retry with the same inputs replays the stored `Result`. A retry with different inputs throws `IdempotencyConflict`. Stripe handlers key on `event.id`.
- **Suspension.** A suspended account cannot open a new spend (`AccountSuspended`). Read-only replay of a prior successful spend still returns the stored result. Open disputes suspend. The suspension lifts only when no dispute on the account is still open, and only if disputes caused it (an operator or clawback-debt suspension stays).
- **Clawback.** Proportional removal of credits granted by a purchase. The balance is never driven negative; leftover obligation is recorded as `debt` in `meta`, and the account is suspended.
- **Holds.** Reserved credits are subtracted from `Holds.available`. Settle, release, and expire are the only ways a hold ends. Double-settle is refused. `Holds.expireDue` is the operator's to schedule.

## Stripe

- **Checkout, not Elements-for-PAN.** `createTopUpCheckout` creates a Stripe Checkout Session. Card numbers stay on Stripe. The library is out of PCI scope for card data; the operator still has to run Checkout and webhooks according to Stripe's PCI documentation.
- **Test mode by default.** `sk_live_` and `rk_live_` keys are refused unless `allowLive === true` or `KE_CREDITS_ALLOW_LIVE=1`. Turning live mode on is a deliberate operator action.
- **Webhook signatures.** `verifyStripeSignature` checks the `Stripe-Signature` HMAC with `node:crypto`, including timestamp tolerance and multiple `v1` signatures. A bad or old signature throws. Call this before `handleStripeEvent`. The payload must be the raw bytes Stripe signed (`req.text()` in App Router; `express.raw({ type: 'application/json' })` in Express).
- **Metadata binding.** Checkout sets `client_reference_id` to the account and metadata `ke_credits_pack` / `ke_credits_account`. Grants use those values plus the pack table from `definePacks`. Unknown events return `{ handled: false }`.
- **Refunds and disputes.** `charge.refunded` claws back in proportion to the refunded amount. `charge.dispute.created` suspends spending. A lost `charge.dispute.closed` claws back the disputed share of the purchase; a won dispute closes it. Dispute state is stored per dispute (`credits_disputes`) and closing is terminal, so out-of-order delivery (a win before its creation, a loss before its creation, concurrent redelivery) converges to the same result. A refund delivered before its grant throws, so the webhook returns 5xx and Stripe retries.

## Secrets and configuration

- Stripe secret keys and webhook signing secrets belong in the operator's environment, not in this repository.
- `fetchImpl` on `createTopUpCheckout` is for tests (a fake `fetch`). Production uses global `fetch`.
- `Ledger` / `Holds` `now` is for tests. Production uses the system clock.

## What this library does not do

It does not move money, store card data, issue stored value, transmit money, or decide tax, consumer-protection, unclaimed-property, prepaid-access, or PCI obligations. Those stay with the operator. The legal line is in [NOTICE](../NOTICE).

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
