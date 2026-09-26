# Security

The threat model is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

## Reporting a vulnerability

Please report ledger, webhook-signature, live-key, or idempotency issues privately through GitHub Security Advisories on this repository. Include a reproduction against PGlite if you can.

Do not open a public issue for a vulnerability until a fix is published.

This library holds no funds and never sees card numbers. Bugs that let a balance go negative, replay the wrong `Result`, skip `verifyStripeSignature`, or accept a live Stripe key without `allowLive` / `KE_CREDITS_ALLOW_LIVE` are in scope.
