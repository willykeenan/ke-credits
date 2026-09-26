/// <reference types="node" />
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ledger } from "../ledger.js";
import type { Pack } from "../packs.js";

export type StripeEventResult = { handled: boolean; action: string };

const DEFAULT_TOLERANCE_SECONDS = 300;

type Queryable = {
  query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

function payloadString(payload: string | Buffer): string {
  if (typeof payload === "string") return payload;
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  throw new Error("Invalid Stripe signature");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const trimmed = item.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "t") {
      if (!/^\d+$/.test(value)) {
        throw new Error("Invalid Stripe signature");
      }
      timestamp = Number.parseInt(value, 10);
    } else if (key === "v1") {
      if (value.length) signatures.push(value);
    }
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || signatures.length === 0) {
    throw new Error("Invalid Stripe signature");
  }
  return { timestamp, signatures };
}

function expectedV1(secret: string, timestamp: number, payload: string | Buffer): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.`);
  hmac.update(payload);
  return hmac.digest("hex");
}

/**
 * Verify a Stripe-Signature header (t= and v1=) with HMAC-SHA256 over
 * `${t}.${payload}`. Any matching v1 is accepted. Throws on a missing,
 * tampered, or old signature. Default timestamp tolerance is 300 seconds.
 */
export function verifyStripeSignature(
  payload: string | Buffer,
  header: string,
  secret: string,
  toleranceSeconds?: number,
): object {
  if (typeof header !== "string" || header.length === 0) {
    throw new Error("Invalid Stripe signature");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Invalid Stripe signature");
  }
  if (typeof payload !== "string" && !Buffer.isBuffer(payload)) {
    throw new Error("Invalid Stripe signature");
  }
  const { timestamp, signatures } = parseSignatureHeader(header);
  const expected = expectedV1(secret, timestamp, payload);
  let matched = false;
  for (const signature of signatures) {
    if (safeEqual(signature, expected)) matched = true;
  }
  if (!matched) {
    throw new Error("Invalid Stripe signature");
  }
  const tolerance =
    toleranceSeconds === undefined ? DEFAULT_TOLERANCE_SECONDS : toleranceSeconds;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (tolerance > 0 && skew > tolerance) {
    throw new Error("Stripe signature timestamp is outside the allowed tolerance");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadString(payload));
  } catch {
    throw new Error("Invalid Stripe signature");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Invalid Stripe signature");
  }
  return parsed as object;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function metaString(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const metadata = (obj as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function accountFrom(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  const fromMeta = metaString(record, "ke_credits_account");
  if (fromMeta) return fromMeta;
  if (typeof record.client_reference_id === "string" && record.client_reference_id.length > 0) {
    return record.client_reference_id;
  }
  if (record.charge && typeof record.charge === "object") {
    const nested = accountFrom(record.charge);
    if (nested) return nested;
  }
  if (record.payment_intent && typeof record.payment_intent === "object") {
    const nested = accountFrom(record.payment_intent);
    if (nested) return nested;
  }
  return null;
}

function packIdFrom(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  const fromMeta = metaString(record, "ke_credits_pack");
  if (fromMeta) return fromMeta;
  if (record.charge && typeof record.charge === "object") {
    const nested = packIdFrom(record.charge);
    if (nested) return nested;
  }
  if (record.payment_intent && typeof record.payment_intent === "object") {
    const nested = packIdFrom(record.payment_intent);
    if (nested) return nested;
  }
  return null;
}

function purchaseRefFrom(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  const direct = idOf(record.payment_intent);
  if (direct) return direct;
  if (record.charge && typeof record.charge === "object") {
    return purchaseRefFrom(record.charge);
  }
  return null;
}

function isCreditsObject(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (packIdFrom(obj) !== null) return true;
  if (metaString(obj, "ke_credits_account") !== null) return true;
  const record = obj as Record<string, unknown>;
  if (record.charge && typeof record.charge === "object" && isCreditsObject(record.charge)) {
    return true;
  }
  if (
    record.payment_intent &&
    typeof record.payment_intent === "object" &&
    isCreditsObject(record.payment_intent)
  ) {
    return true;
  }
  return false;
}

function findPack(packs: Pack[], id: string): Pack | undefined {
  return packs.find((pack) => pack.id === id);
}

function requireEventId(event: { id?: unknown }): string {
  if (typeof event.id !== "string" || event.id.length === 0) {
    throw new Error("Stripe event is missing id");
  }
  return event.id;
}

function ledgerDb(ledger: Ledger): Queryable | null {
  const db = (ledger as unknown as { db?: Queryable }).db;
  if (!db || typeof db.query !== "function") return null;
  return db;
}

async function findAccountByPurchaseRef(
  ledger: Ledger,
  purchaseRef: string,
): Promise<string | null> {
  const db = ledgerDb(ledger);
  if (!db) return null;
  const res = await db.query<{ account: string }>(
    `SELECT account FROM credits_ledger
     WHERE ref = $1 AND kind = 'grant'
     ORDER BY at ASC, id ASC
     LIMIT 1`,
    [purchaseRef],
  );
  const account = res.rows[0]?.account;
  return typeof account === "string" && account.length > 0 ? account : null;
}

async function resolveAccount(
  ledger: Ledger,
  obj: unknown,
): Promise<string | null> {
  const fromPayload = accountFrom(obj);
  if (fromPayload) return fromPayload;
  const purchaseRef = purchaseRefFrom(obj);
  if (!purchaseRef) return null;
  return findAccountByPurchaseRef(ledger, purchaseRef);
}

async function handleCheckoutCompleted(
  event: { id?: unknown; type?: unknown },
  session: Record<string, unknown>,
  deps: { ledger: Ledger; packs: Pack[] },
): Promise<StripeEventResult> {
  const packId = packIdFrom(session);
  const account = accountFrom(session);
  if (!packId || !account) return { handled: false, action: "ignored" };
  if (typeof session.mode === "string" && session.mode !== "payment") {
    return { handled: false, action: "ignored" };
  }
  if (session.payment_status !== "paid") {
    if (event.type === "checkout.session.async_payment_succeeded") {
      throw new Error("Checkout async payment is not marked paid");
    }
    return { handled: true, action: "pending" };
  }
  const pack = findPack(deps.packs, packId);
  if (!pack) throw new Error(`Unknown credit pack: ${packId}`);
  if (typeof session.amount_total === "number" && session.amount_total !== pack.amount) {
    throw new Error("Checkout amount does not match pack");
  }
  if (
    typeof session.currency === "string" &&
    session.currency.toLowerCase() !== pack.currency.toLowerCase()
  ) {
    throw new Error("Checkout currency does not match pack");
  }
  const eventId = requireEventId(event);
  const sessionId = idOf(session.id);
  const purchaseRef = purchaseRefFrom(session) ?? sessionId;
  if (!purchaseRef) throw new Error("Checkout session is missing a purchase ref");
  await deps.ledger.createAccount(account);
  await deps.ledger.grant({
    account,
    credits: pack.credits,
    ref: purchaseRef,
    idempotencyKey: sessionId ?? eventId,
    meta: {
      pack: pack.id,
      session: sessionId,
      payment_intent: purchaseRefFrom(session),
    },
  });
  return { handled: true, action: "grant" };
}

async function handleChargeRefunded(
  event: { id?: unknown },
  charge: Record<string, unknown>,
  deps: { ledger: Ledger; packs: Pack[] },
): Promise<StripeEventResult> {
  const purchaseRef = purchaseRefFrom(charge);
  const account = await resolveAccount(deps.ledger, charge);
  if (!account || !purchaseRef) {
    if (isCreditsObject(charge)) {
      throw new Error("Refunded charge is missing account or payment_intent");
    }
    return { handled: false, action: "ignored" };
  }
  const amount = Number(charge.amount);
  const refunded = Number(charge.amount_refunded);
  if (!(amount > 0) || !(refunded > 0)) return { handled: false, action: "ignored" };
  const fraction = Math.min(1, refunded / amount);
  if (!(fraction > 0)) return { handled: false, action: "ignored" };
  await deps.ledger.clawback({
    account,
    purchaseRef,
    fraction,
    idempotencyKey: requireEventId(event),
    reason: "stripe:charge.refunded",
  });
  return { handled: true, action: "clawback" };
}

/** Share of the charge under dispute (a partial dispute takes back a partial share). */
function disputedFraction(dispute: Record<string, unknown>): number {
  const charge = dispute.charge;
  const chargeAmount =
    charge && typeof charge === "object" ? Number((charge as Record<string, unknown>).amount) : NaN;
  const disputed = Number(dispute.amount);
  if (chargeAmount > 0 && disputed > 0) return Math.min(1, disputed / chargeAmount);
  return 1;
}

async function handleDispute(
  event: { id?: unknown; type?: unknown },
  dispute: Record<string, unknown>,
  deps: { ledger: Ledger; packs: Pack[] },
): Promise<StripeEventResult> {
  const account = await resolveAccount(deps.ledger, dispute);
  if (!account) {
    if (isCreditsObject(dispute)) {
      throw new Error("Dispute is missing ke_credits_account");
    }
    return { handled: false, action: "ignored" };
  }
  const disputeId = idOf(dispute.id);
  if (!disputeId) throw new Error("Dispute is missing id");
  // Stripe does not order events: the dispute's state lives in the ledger, a
  // closing status is terminal, and only disputes that are still open suspend.
  if (event.type === "charge.dispute.created") {
    await deps.ledger.setDisputeStatus(account, disputeId, "open");
    return { handled: true, action: "suspend" };
  }
  const status = String(dispute.status ?? "").toLowerCase();
  if (status === "lost") {
    const purchaseRef = purchaseRefFrom(dispute);
    if (!purchaseRef) throw new Error("Dispute is missing payment_intent");
    await deps.ledger.clawback({
      account,
      purchaseRef,
      fraction: disputedFraction(dispute),
      idempotencyKey: requireEventId(event),
      reason: "stripe:charge.dispute.closed:lost",
    });
    await deps.ledger.setDisputeStatus(account, disputeId, "lost");
    return { handled: true, action: "clawback" };
  }
  if (status === "won" || status === "warning_closed") {
    await deps.ledger.setDisputeStatus(account, disputeId, "won");
    return { handled: true, action: "unsuspend" };
  }
  await deps.ledger.setDisputeStatus(account, disputeId, "closed");
  return { handled: true, action: "closed" };
}

/**
 * Translate a verified Stripe event into ledger mutations.
 * Unknown events return `{ handled: false }`. Every mutation is idempotent on `event.id`.
 */
export async function handleStripeEvent(
  event: any,
  deps: { ledger: Ledger; packs: Pack[] },
): Promise<StripeEventResult> {
  if (!event || typeof event !== "object") {
    return { handled: false, action: "ignored" };
  }
  const type = event.type;
  const object =
    event.data && typeof event.data === "object"
      ? (event.data as { object?: unknown }).object
      : undefined;
  if (typeof type !== "string" || !object || typeof object !== "object") {
    return { handled: false, action: "ignored" };
  }
  const obj = object as Record<string, unknown>;
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutCompleted(event, obj, deps);
    case "charge.refunded":
      return handleChargeRefunded(event, obj, deps);
    case "charge.dispute.created":
    case "charge.dispute.closed":
      return handleDispute(event, obj, deps);
    default:
      return { handled: false, action: "ignored" };
  }
}
