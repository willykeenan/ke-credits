/// <reference types="node" />
import type { Pack } from "../packs.js";

const CHECKOUT_SESSIONS_URL = "https://api.stripe.com/v1/checkout/sessions";

export async function createTopUpCheckout(opts: {
  secretKey: string;
  pack: Pack;
  account: string;
  successUrl: string;
  cancelUrl: string;
  fetchImpl?: typeof fetch;
  allowLive?: boolean;
}): Promise<{ id: string; url: string }> {
  const {
    secretKey,
    pack,
    account,
    successUrl,
    cancelUrl,
    fetchImpl = fetch,
    allowLive,
  } = opts;

  if (isLiveSecretKey(secretKey) && !liveModeAllowed(allowLive)) {
    throw new Error(
      "Live Stripe keys (sk_live_/rk_live_) are refused unless allowLive is true or KE_CREDITS_ALLOW_LIVE=1",
    );
  }

  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);
  body.set("client_reference_id", account);
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", pack.currency);
  body.set("line_items[0][price_data][unit_amount]", String(pack.amount));
  body.set(
    "line_items[0][price_data][product_data][name]",
    pack.label ?? pack.id,
  );
  body.set("metadata[ke_credits_pack]", pack.id);
  body.set("metadata[ke_credits_account]", account);
  // Copied onto the PaymentIntent (and so its charges), so a refund or dispute
  // identifies its account even if Stripe delivers it before the grant.
  body.set("payment_intent_data[metadata][ke_credits_pack]", pack.id);
  body.set("payment_intent_data[metadata][ke_credits_account]", account);

  const res = await fetchImpl(CHECKOUT_SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Stripe Checkout Session request failed (${res.status}): ${text}`,
    );
  }

  const json = (await res.json()) as { id?: unknown; url?: unknown };
  if (typeof json.id !== "string" || typeof json.url !== "string") {
    throw new Error("Stripe Checkout Session response missing id or url");
  }
  return { id: json.id, url: json.url };
}

function isLiveSecretKey(secretKey: string): boolean {
  return secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_");
}

function liveModeAllowed(allowLive?: boolean): boolean {
  return allowLive === true || process.env.KE_CREDITS_ALLOW_LIVE === "1";
}
