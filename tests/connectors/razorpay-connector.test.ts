import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../src/connector.js";
import { RAZORPAY_REFUND_CAPABILITY, createRazorpayConnector } from "../../src/connectors/razorpay/razorpay-connector.js";

const PAYMENT = "pay_TestPayment01";
const TRANSACTION = "txn-razorpay-1";
const TEST_KEY = "rzp_test_abc123:secretvalue";
const LIVE_KEY = "rzp_live_abc123:secretvalue";

interface Recorded {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** A fake Razorpay. `existing` are the refunds already on the payment; `refundStatus` is what POST /refund answers. */
function fakeRazorpay(options: { existing?: Array<Record<string, unknown>>; refundStatus?: number; refundBody?: unknown } = {}) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      auth: headers.get("authorization"),
      body: init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)),
    });
    if (method === "GET") {
      return Response.json({ entity: "collection", items: options.existing ?? [] });
    }
    const status = options.refundStatus ?? 200;
    if (status !== 200) {
      return Response.json(options.refundBody ?? { error: { code: "BAD_REQUEST_ERROR", description: "The amount exceeds the refundable amount." } }, { status });
    }
    return Response.json(options.refundBody ?? { id: "rfnd_NEW001", amount: 100, status: "processed", payment_id: PAYMENT, receipt: TRANSACTION });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function request(overrides: Partial<ConnectorRequest> = {}): ConnectorRequest {
  return {
    capability: RAZORPAY_REFUND_CAPABILITY,
    parameters: { amount: 100 },
    target: PAYMENT,
    businessTransactionId: TRANSACTION,
    ...overrides,
  };
}

function context(value = TEST_KEY): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "RAZORPAY_KEY_PAIR", value }, timeoutMs: 10_000 };
}

describe("createRazorpayConnector", () => {
  it("describes one capability for the system razorpay", () => {
    const connector = createRazorpayConnector({ fetch: fakeRazorpay().fetch });
    expect(connector.system).toBe("razorpay");
    expect(connector.capabilities).toEqual([RAZORPAY_REFUND_CAPABILITY]);
  });

  it("refunds once, with the transaction id as the receipt and basic auth", async () => {
    const razorpay = fakeRazorpay();
    const response = await createRazorpayConnector({ fetch: razorpay.fetch }).execute(request(), context());

    expect(response.success).toBe(true);
    expect(response.metadata.body).toMatchObject({ refundId: "rfnd_NEW001", alreadyRefunded: false });
    expect(razorpay.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(razorpay.calls[0]?.url).toContain(`/payments/${PAYMENT}/refunds`);
    expect(razorpay.calls[1]?.body).toMatchObject({ amount: 100, receipt: TRANSACTION });
    expect(razorpay.calls[1]?.auth).toBe(`Basic ${Buffer.from("rzp_test_abc123:secretvalue").toString("base64")}`);
  });

  it("returns the earlier refund instead of refunding again when the receipt already exists", async () => {
    const razorpay = fakeRazorpay({
      existing: [{ id: "rfnd_OLD001", amount: 100, status: "processed", payment_id: PAYMENT, receipt: TRANSACTION }],
    });
    const response = await createRazorpayConnector({ fetch: razorpay.fetch }).execute(request(), context());

    expect(response.metadata.body).toMatchObject({ refundId: "rfnd_OLD001", alreadyRefunded: true });
    expect(razorpay.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refuses a live key unless live keys are allowed, before any call is made", async () => {
    const razorpay = fakeRazorpay();
    const connector = createRazorpayConnector({ fetch: razorpay.fetch });

    await expect(connector.execute(request(), context(LIVE_KEY))).rejects.toMatchObject({ code: "credential_invalid" });
    expect(razorpay.calls).toHaveLength(0);
  });

  it("accepts a live key only when the caller allows live keys", async () => {
    const razorpay = fakeRazorpay();
    const connector = createRazorpayConnector({ fetch: razorpay.fetch, allowLiveKeys: true });

    await expect(connector.execute(request(), context(LIVE_KEY))).resolves.toMatchObject({ success: true });
  });

  it("refuses a malformed credential without echoing it", async () => {
    const connector = createRazorpayConnector({ fetch: fakeRazorpay().fetch });

    const error = await connector.execute(request(), context("not-a-key-pair")).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("credential_invalid");
    expect((error as Error).message).not.toContain("not-a-key-pair");
  });

  it("refuses a target that is not a payment id, before any call is made", async () => {
    const razorpay = fakeRazorpay();
    const error = await createRazorpayConnector({ fetch: razorpay.fetch })
      .execute(request({ target: "order_123" }), context())
      .catch((err: unknown) => err);

    expect((error as ConnectorError).code).toBe("invalid_input");
    expect(razorpay.calls).toHaveLength(0);
  });

  it.each([0, -5, 1.5, "100"])("refuses the amount %j, before any call is made", async (amount) => {
    const razorpay = fakeRazorpay();
    const error = await createRazorpayConnector({ fetch: razorpay.fetch })
      .execute(request({ parameters: { amount } }), context())
      .catch((err: unknown) => err);

    expect((error as ConnectorError).code).toBe("invalid_input");
    expect(razorpay.calls).toHaveLength(0);
  });

  it("refuses a capability it does not serve", async () => {
    const error = await createRazorpayConnector({ fetch: fakeRazorpay().fetch })
      .execute(request({ capability: "paytm:refund" }), context())
      .catch((err: unknown) => err);

    expect((error as ConnectorError).code).toBe("unknown_capability");
  });

  it("reports Razorpay's refusal with its code, and never the credential", async () => {
    const razorpay = fakeRazorpay({ refundStatus: 400 });
    const error = await createRazorpayConnector({ fetch: razorpay.fetch })
      .execute(request(), context())
      .catch((err: unknown) => err);

    expect((error as ConnectorError).code).toBe("upstream_error");
    expect((error as Error).message).toContain("BAD_REQUEST_ERROR");
    expect((error as Error).message).toContain("HTTP 400");
    expect((error as Error).message).not.toContain("secretvalue");
  });

  it("reports a network failure as unknown, and says to resend the same release", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const error = await createRazorpayConnector({ fetch: failing })
      .execute(request(), context())
      .catch((err: unknown) => err);

    expect((error as ConnectorError).code).toBe("upstream_error");
    expect((error as Error).message).toContain("resend the same release");
  });
});
