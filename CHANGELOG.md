# Changelog

## 0.1.0

Initial release.

- Append-only Postgres ledger: `Ledger.createAccount`, `balance`, `history`, `grant`, `spend`, `refund`, `clawback`, `suspend`, `unsuspend`, `setDisputeStatus`.
- Idempotent operations with stored `Result` replay and `IdempotencyConflict` on a mismatched retry.
- `Holds` for reserve / settle / release / expire on long-running jobs.
- `definePacks` for credit packs.
- Stripe adapter: `createTopUpCheckout` (test mode by default; live keys require `allowLive` or `KE_CREDITS_ALLOW_LIVE=1`) and `handleStripeEvent` after `verifyStripeSignature`.
- Webhook handling is safe in any delivery order: per-dispute state with terminal closing statuses, cumulative clawbacks per purchase, and a thrown error (answer 5xx) when a refund beats its grant so Stripe retries.
- `migrate` / `MIGRATIONS`, also shipped as `sql/*.sql`.
- Driver-agnostic `Db` / `Sql` (pg, postgres.js, PGlite, Neon).
