import { createDecipheriv, createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import { PAYTM_REFUND_CAPABILITY, createPaytmConnector, paytmChecksum, parsePaytmCredential } from "../../../src/connectors/paytm/paytm-connector.js";

const MERCHANT_ID = "MERCHANT123456789";
const MERCHANT_KEY = "abcdefghijklmnop";
const CREDENTIAL = `${MERCHANT_ID}:${MERCHANT_KEY}`;
const TRANSACTION = "3b8f4c1e-2a7d-4e9b-9c6f-1d2e3f4a5b6c";

interface Recorded {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly signature: string;
}

/**
 * A fake of the Paytm endpoints the connector calls. `status` answers
 * /v2/refund/status and `apply` answers /refund/apply. Each call is recorded.
 */
function fakePaytm(responses: { status?: Record<string, unknown>; apply?: Record<string, unknown>; applyHttp?: number; applyThrows?: boolean; statusThrows?: boolean }) {
  const calls: Recorded[] = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const payload = JSON.parse(String(init?.body)) as { body: Record<string, unknown>; head: { signature: string } };
    calls.push({ path: url.pathname, body: payload.body, signature: payload.head.signature });

    if (url.pathname === "/v2/refund/status") {
      if (responses.statusThrows) throw new Error("network down");
      return new Response(JSON.stringify({ body: responses.status ?? { resultInfo: { resultStatus: "NOT_FOUND" } } }), { status: 200 });
    }
    if (url.pathname === "/refund/apply") {
      if (responses.applyThrows) throw new Error("connection reset");
      return new Response(JSON.stringify({ body: responses.apply ?? { resultInfo: { resultStatus: "TXN_SUCCESS", resultCode: "10" } } }), {
        status: responses.applyHttp ?? 200,
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: fetchFn, calls };
}

function request(overrides: Partial<ConnectorRequest> = {}, parameters: Record<string, unknown> = {}): ConnectorRequest {
  return {
    capability: PAYTM_REFUND_CAPABILITY,
    parameters: { orderId: "ORDER-1", transactionId: "TXN-9", amount: 250.5, ...parameters },
    businessTransactionId: TRANSACTION,
    ...overrides,
  };
}

function context(value: string = CREDENTIAL): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "paytm", value }, timeoutMs: 5_000 };
}

describe("paytm connector: credential", () => {
  it("accepts a merchant id and a 16 byte merchant key", () => {
    expect(parsePaytmCredential(CREDENTIAL)).toEqual({ merchantId: MERCHANT_ID, merchantKey: MERCHANT_KEY });
  });

  it("refuses a key that is not 16 bytes, without showing it", () => {
    try {
      parsePaytmCredential(`${MERCHANT_ID}:short`);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe("credential_invalid");
      expect((error as ConnectorError).message).not.toContain("short");
    }
  });

  it("refuses a value with no separator", () => {
    expect(() => parsePaytmCredential("no-separator")).toThrow(ConnectorError);
  });
});

describe("paytm connector: environment", () => {
  it("refuses production unless allowProduction is true", () => {
    expect(() => createPaytmConnector({ environment: "production" })).toThrow(/Production Paytm is refused/);
  });

  it("allows production when allowProduction is true", () => {
    expect(() => createPaytmConnector({ environment: "production", allowProduction: true, fetch: fakePaytm({}).fetch })).not.toThrow();
  });
});

describe("paytm connector: request checks, before any call", () => {
  it("refuses another capability", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request({ capability: "paytm:payout" }), context())).rejects.toMatchObject({ code: "unknown_capability" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a parameter that is not allowed", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request({}, { destination: "elsewhere" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an amount with more than two decimals", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request({}, { amount: 1.005 }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a zero or negative amount", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request({}, { amount: 0 }), context())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(connector.execute(request({}, { amount: -5 }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a refundReason longer than 256 characters", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request({}, { refundReason: "x".repeat(257) }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("paytm connector: sending a refund", () => {
  it("sends a refund and returns the confirmed result", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });

    const response = await connector.execute(request(), context());

    expect(response.success).toBe(true);
    expect(response.metadata.body).toEqual({ refId: TRANSACTION, reused: false, paytmStatus: "TXN_SUCCESS" });
    expect(fake.calls.map((call) => call.path)).toEqual(["/v2/refund/status", "/refund/apply"]);
    const apply = fake.calls[1]?.body ?? {};
    expect(apply).toMatchObject({
      txnType: "REFUND",
      orderId: "ORDER-1",
      txnId: "TXN-9",
      refId: TRANSACTION,
      refundAmount: "250.50",
      mid: MERCHANT_ID,
    });
  });

  it("uses the refundReference as the refId when one is given", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await connector.execute(request({}, { refundReference: "REF-77" }), context());
    expect(fake.calls[1]?.body["refId"]).toBe("REF-77");
  });

  it("returns the existing refund instead of sending a second one", async () => {
    const fake = fakePaytm({ status: { resultInfo: { resultStatus: "TXN_SUCCESS", resultCode: "10" } } });
    const connector = createPaytmConnector({ fetch: fake.fetch });

    const response = await connector.execute(request(), context());

    expect(response.metadata.body).toEqual({ refId: TRANSACTION, reused: true, paytmStatus: "TXN_SUCCESS" });
    expect(fake.calls.map((call) => call.path)).toEqual(["/v2/refund/status"]);
  });

  it("refuses a pending refund without sending it again", async () => {
    const fake = fakePaytm({ status: { resultInfo: { resultStatus: "PENDING" } } });
    const connector = createPaytmConnector({ fetch: fake.fetch });

    await expect(connector.execute(request(), context())).rejects.toMatchObject({ code: "upstream_error" });
    expect(fake.calls.map((call) => call.path)).toEqual(["/v2/refund/status"]);
  });

  it("does not report a PENDING apply result as success", async () => {
    const fake = fakePaytm({ apply: { resultInfo: { resultStatus: "PENDING" } } });
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request(), context())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("reports a refund Paytm did not confirm as an error", async () => {
    const fake = fakePaytm({ apply: { resultInfo: { resultStatus: "TXN_FAILURE", resultCode: "501" } } });
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request(), context())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("tells the operator to check Paytm when the refund call fails after it was sent", async () => {
    const fake = fakePaytm({ applyThrows: true });
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request(), context())).rejects.toThrow(/Check Paytm/);
  });

  it("says no refund was sent when the status check fails", async () => {
    const fake = fakePaytm({ statusThrows: true });
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await expect(connector.execute(request(), context())).rejects.toMatchObject({ code: "timeout" });
    expect(fake.calls.map((call) => call.path)).not.toContain("/refund/apply");
  });

  it("never shows the merchant key in an error", async () => {
    const fake = fakePaytm({ apply: { resultInfo: { resultStatus: "TXN_FAILURE" } } });
    const connector = createPaytmConnector({ fetch: fake.fetch });
    try {
      await connector.execute(request(), context());
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(MERCHANT_KEY);
    }
  });
});

describe("paytm connector: checksum", () => {
  it("encrypts sha256(body|salt) with the merchant key, as Paytm's scheme expects", () => {
    const json = JSON.stringify({ orderId: "ORDER-1", mid: MERCHANT_ID });
    const salt = "abcd";
    const signature = paytmChecksum(json, MERCHANT_KEY, salt);

    const decipher = createDecipheriv("aes-128-cbc", Buffer.from(MERCHANT_KEY, "utf8"), Buffer.from("@@@@&&&&####$$$$", "utf8"));
    const plain = Buffer.concat([decipher.update(Buffer.from(signature, "base64")), decipher.final()]).toString("utf8");

    const expectedHash = createHash("sha256").update(`${json}|${salt}`, "utf8").digest("hex");
    expect(plain).toBe(expectedHash + salt);
  });

  it("the signature sent to Paytm verifies against the body it was sent with", async () => {
    const fake = fakePaytm({});
    const connector = createPaytmConnector({ fetch: fake.fetch });
    await connector.execute(request(), context());

    const apply = fake.calls[1];
    expect(apply).toBeDefined();
    const decipher = createDecipheriv("aes-128-cbc", Buffer.from(MERCHANT_KEY, "utf8"), Buffer.from("@@@@&&&&####$$$$", "utf8"));
    const plain = Buffer.concat([decipher.update(Buffer.from(apply?.signature ?? "", "base64")), decipher.final()]).toString("utf8");
    const hash = plain.slice(0, 64);
    const salt = plain.slice(64);
    expect(createHash("sha256").update(`${JSON.stringify(apply?.body)}|${salt}`, "utf8").digest("hex")).toBe(hash);
  });
});

describe("paytm connector: ambiguous outcomes and redirects", () => {
  it("tells the operator to check Paytm when the apply call is refused after it was sent", async () => {
    const paytm = fakePaytm({ applyHttp: 500, apply: { resultInfo: { resultStatus: "F", resultCode: "9999" } } });

    await expect(createPaytmConnector({ fetch: paytm.fetch }).execute(request(), context())).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringMatching(/HTTP 500[\s\S]*check Paytm for refId/),
    });
  });

  it("refuses to follow a redirect on the status check or the refund", async () => {
    const paytm = fakePaytm({});
    const seen: Array<RequestRedirect | undefined> = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.redirect);
      return paytm.fetch(input, init);
    }) as unknown as typeof fetch;

    await createPaytmConnector({ fetch: spy }).execute(request(), context());

    expect(seen).toEqual(["error", "error"]);
  });
});
