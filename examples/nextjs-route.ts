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

/** App Router: `export const POST = stripeWebhookPOST(db)` in `app/api/webhooks/stripe/route.ts`. */
export function stripeWebhookPOST(db: Db) {
  const ledger = new Ledger(db);
  return async function POST(req: Request): Promise<Response> {
    const payload = await req.text();
    const header = req.headers.get('stripe-signature') ?? '';
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      return new Response('webhook secret missing', { status: 500 });
    }
    let event: object;
    try {
      event = verifyStripeSignature(payload, header, secret);
    } catch {
      return new Response('invalid signature', { status: 400 });
    }
    try {
      return Response.json(await handleStripeEvent(event, { ledger, packs }));
    } catch (err) {
      // 5xx makes Stripe retry (e.g. a refund that arrived before its grant).
      return new Response(err instanceof Error ? err.message : 'webhook failed', { status: 500 });
    }
  };
}
