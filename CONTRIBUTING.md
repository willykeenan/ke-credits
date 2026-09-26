# Contributing

KE Credits is Apache-2.0, copyright KE Studios. By submitting a change you agree to license it under Apache-2.0.

## Setup

Node 20 or newer.

```bash
npm install
npm test
npm run typecheck
npm run build
```

Tests run with `node --import tsx --test test/*.test.ts` against PGlite (a Postgres engine in WASM). There is no network in tests. Stripe is exercised with fixture events and a fake `fetch`.

## What to change

- Ledger, holds, packs, schema, and errors: `src/` plus `sql/` and `test/ledger.test.ts`, `test/holds.test.ts`, `test/schema.test.ts`, `test/concurrency.test.ts`.
- Stripe adapter: `src/stripe/` plus `test/stripe-checkout.test.ts`, `test/stripe-webhooks.test.ts`, `test/fixtures/`.
- Docs: `README.md`, `NOTICE`, `docs/GUIDE.md`, `docs/SECURITY-MODEL.md`, `examples/`, `CHANGELOG.md`.

Keep the public surface identical to [`docs/API.md`](docs/API.md). New exports belong in `src/index.ts` and in that file before they appear in the README.

Do not add runtime dependencies. Stripe stays on `fetch` and `node:crypto`.

## Checks that must stay true

- The balance never goes negative under concurrent spends.
- Idempotent replay, and a conflict on a mismatched retry.
- Append-only entries: no `UPDATE` or `DELETE`.
- Refunds limited to the spent amount; clawback is proportional.
- A suspended account cannot spend.
- Hold lifecycle: expiry and double-settle refusal.
- Migrations are idempotent; checksum drift is refused.
- Webhook signatures: valid, tampered, old timestamp, multiple `v1` signatures.
- Live-key refusal unless `allowLive` or `KE_CREDITS_ALLOW_LIVE=1`.

## Changelog

Add a note under the next version in `CHANGELOG.md`.
