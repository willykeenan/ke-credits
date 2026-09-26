import {
  definePacks,
  handleStripeEvent,
  Ledger,
  verifyStripeSignature,
} from 'ke-credits';
import type { Db } from 'ke-credits';

const packs = definePacks([
  { id: 'pack_a', credits: 250, amount: 2000, currency: 'usd', label: 'Pack A' },
]);

/**
 * HMAC verification needs the raw bytes. Register as:
 *   app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
 *   stripeWebhook(app, db);
 * Do not run `express.json()` on this path first.
 */
export function stripeWebhook(
  app: {
    post: (path: string, ...handlers: Function[]) => unknown;
  },
  db: Db,
): void {
  const ledger = new Ledger(db);
  app.post('/webhooks/stripe', async (req: any, res: any) => {
    const payload = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? req.body
        : null;
    if (payload == null) {
      res.status(400).send('raw body required (express.raw({ type: "application/json" }))');
      return;
    }
    const header = String(req.headers['stripe-signature'] ?? '');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).send('webhook secret missing');
      return;
    }
    let event: object;
    try {
      event = verifyStripeSignature(payload, header, secret);
    } catch {
      res.status(400).send('invalid signature');
      return;
    }
    try {
      const result = await handleStripeEvent(event, { ledger, packs });
      res.json(result);
    } catch (err) {
      res.status(500).send(err instanceof Error ? err.message : 'webhook failed');
    }
  });
}
