import assert from "node:assert/strict";
import test from "node:test";
import { createTopUpCheckout, definePacks } from "../src/index.ts";

const PACK = definePacks([
  {
    id: "pack_test_a",
    credits: 250,
    amount: 2000,
    currency: "usd",
    label: "Pack A",
  },
])[0];

const ACCOUNT = "acct_test_1";
const SUCCESS_URL = "https://example.test/credits/ok";
const CANCEL_URL = "https://example.test/credits/cancel";
const TEST_KEY = "sk_test_invented_51";
const LIVE_KEY = "sk_live_invented_99";
const LIVE_RESTRICTED_KEY = "rk_live_invented_99";
const SESSION_ID = "cs_test_invented_01HZXSESSION";
const SESSION_URL =
  "https://checkout.stripe.com/c/pay/cs_test_invented_01HZXSESSION";

const EXPECTED_FORM: Record<string, string> = {
  mode: "payment",
  success_url: SUCCESS_URL,
  cancel_url: CANCEL_URL,
  client_reference_id: ACCOUNT,
  "line_items[0][quantity]": "1",
  "line_items[0][price_data][currency]": PACK.currency,
  "line_items[0][price_data][unit_amount]": String(PACK.amount),
  "line_items[0][price_data][product_data][name]": PACK.label ?? PACK.id,
  "metadata[ke_credits_pack]": PACK.id,
  "metadata[ke_credits_account]": ACCOUNT,
  "payment_intent_data[metadata][ke_credits_pack]": PACK.id,
  "payment_intent_data[metadata][ke_credits_account]": ACCOUNT,
};

function parseForm(body: unknown): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(body)));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeCheckoutFetch(opts?: {
  onCall?: (input: string, init: RequestInit) => void;
  payload?: unknown;
  status?: number;
}): typeof fetch {
  return (async (input, init) => {
    opts?.onCall?.(String(input), init ?? {});
    const status = opts?.status ?? 200;
    if (status < 200 || status >= 300) {
      const payload = opts?.payload ?? { error: { message: "request failed" } };
      return new Response(
        typeof payload === "string" ? payload : JSON.stringify(payload),
        { status },
      );
    }
    return jsonResponse(
      opts?.payload ?? { id: SESSION_ID, url: SESSION_URL },
      status,
    );
  }) as typeof fetch;
}

async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("posts form-encoded Checkout Session and returns id and url", async () => {
  let calls = 0;
  const fetchImpl = fakeCheckoutFetch({
    onCall(input, init) {
      calls += 1;
      assert.equal(input, "https://api.stripe.com/v1/checkout/sessions");
      assert.equal(init.method, "POST");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TEST_KEY}`);
      assert.equal(
        headers.get("content-type"),
        "application/x-www-form-urlencoded",
      );
      assert.deepEqual(parseForm(init.body), EXPECTED_FORM);
      assert.equal(
        String(init.body),
        new URLSearchParams(EXPECTED_FORM).toString(),
      );
    },
  });

  const session = await createTopUpCheckout({
    secretKey: TEST_KEY,
    pack: PACK,
    account: ACCOUNT,
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
    fetchImpl,
  });

  assert.equal(calls, 1);
  assert.deepEqual(session, { id: SESSION_ID, url: SESSION_URL });
});

test("uses pack id as product name when label is omitted", async () => {
  const pack = definePacks([
    { id: "pack_test_b", credits: 80, amount: 900, currency: "usd" },
  ])[0];
  const fetchImpl = fakeCheckoutFetch({
    onCall(_input, init) {
      const form = parseForm(init.body);
      assert.equal(
        form["line_items[0][price_data][product_data][name]"],
        "pack_test_b",
      );
      assert.equal(form["line_items[0][price_data][unit_amount]"], "900");
      assert.equal(form["metadata[ke_credits_pack]"], "pack_test_b");
    },
  });

  await createTopUpCheckout({
    secretKey: TEST_KEY,
    pack,
    account: ACCOUNT,
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
    fetchImpl,
  });
});

test("refuses sk_live_ and rk_live_ keys", async () => {
  await withEnv("KE_CREDITS_ALLOW_LIVE", undefined, async () => {
    for (const secretKey of [LIVE_KEY, LIVE_RESTRICTED_KEY]) {
      for (const allowLive of [undefined, false] as const) {
        let called = 0;
        await assert.rejects(
          () =>
            createTopUpCheckout({
              secretKey,
              pack: PACK,
              account: ACCOUNT,
              successUrl: SUCCESS_URL,
              cancelUrl: CANCEL_URL,
              ...(allowLive === false ? { allowLive: false } : {}),
              fetchImpl: fakeCheckoutFetch({
                onCall() {
                  called += 1;
                },
              }),
            }),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /sk_live_\/rk_live_/);
            assert.match(err.message, /KE_CREDITS_ALLOW_LIVE/);
            return true;
          },
        );
        assert.equal(
          called,
          0,
          `fetch must not run for ${secretKey} (allowLive=${String(allowLive)})`,
        );
      }
    }
  });
});

test("allowLive overrides live-key refusal", async () => {
  await withEnv("KE_CREDITS_ALLOW_LIVE", undefined, async () => {
    let calls = 0;
    const fetchImpl = fakeCheckoutFetch({
      onCall(input, init) {
        calls += 1;
        assert.equal(input, "https://api.stripe.com/v1/checkout/sessions");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), `Bearer ${LIVE_KEY}`);
        assert.deepEqual(parseForm(init.body), EXPECTED_FORM);
      },
    });

    const session = await createTopUpCheckout({
      secretKey: LIVE_KEY,
      pack: PACK,
      account: ACCOUNT,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
      allowLive: true,
      fetchImpl,
    });

    assert.equal(calls, 1);
    assert.deepEqual(session, { id: SESSION_ID, url: SESSION_URL });
  });
});

test("KE_CREDITS_ALLOW_LIVE=1 overrides live-key refusal", async () => {
  await withEnv("KE_CREDITS_ALLOW_LIVE", "1", async () => {
    const session = await createTopUpCheckout({
      secretKey: LIVE_RESTRICTED_KEY,
      pack: PACK,
      account: ACCOUNT,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
      fetchImpl: fakeCheckoutFetch(),
    });
    assert.deepEqual(session, { id: SESSION_ID, url: SESSION_URL });
  });
});

test("throws a clear error on non-2xx", async () => {
  await assert.rejects(
    () =>
      createTopUpCheckout({
        secretKey: TEST_KEY,
        pack: PACK,
        account: ACCOUNT,
        successUrl: SUCCESS_URL,
        cancelUrl: CANCEL_URL,
        fetchImpl: fakeCheckoutFetch({
          status: 401,
          payload: '{"error":{"message":"Invalid API Key provided"}}',
        }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /401/);
      assert.match(err.message, /Invalid API Key provided/);
      return true;
    },
  );
});
