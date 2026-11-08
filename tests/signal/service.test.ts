import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { CanonicalSerializer } from "@parmana/crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSignalHttpServer,
  type SignalServiceOptions,
} from "../../src/signal/service.js";
import type {
  SignalQueryMessage,
  SignedSignalAnswer,
  SignedSignalQuery,
} from "../../src/signal/protocol.js";

/**
 * The Razorpay signal service, over real HTTP. parmana-core signs each query; the service answers only
 * signed queries for its own audience and source, and signs its answer. Razorpay is a fake fetch.
 */

const serializer = new CanonicalSerializer();
const parmana = generateKeyPairSync("ed25519");
const signer = generateKeyPairSync("ed25519");
const AUDIENCE = "https://signal.example.com/refund-payment";
const SECRET = "rzp_test_keyid:super-secret-value";
const PAYMENT = "pay_TestPayment01";
const NOW = new Date("2026-11-08T10:00:00.000Z");
const pem = (key: KeyObject) =>
  key.export({ type: "spki", format: "pem" }).toString();
const privatePem = (key: KeyObject) =>
  key.export({ type: "pkcs8", format: "pem" }).toString();

function query(
  overrides: Partial<SignalQueryMessage> = {},
): SignalQueryMessage {
  return {
    version: 1,
    source: "razorpay-payments",
    audience: AUDIENCE,
    signalKey: "payment.refundable",
    claim: "payment.refundable",
    subject: PAYMENT,
    action: "razorpay:refund",
    businessTransactionId: "bt-7",
    nonce: "nonce-1",
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    parameters: { amount: 1000 },
    ...overrides,
  };
}

function signed(
  message: SignalQueryMessage,
  key: KeyObject = parmana.privateKey,
  keyId = "default",
): SignedSignalQuery {
  const value = sign(
    null,
    Buffer.from(serializer.serialize(message)),
    key,
  ).toString("base64");
  return { query: message, signature: { algorithm: "ed25519", keyId, value } };
}

function fakeRazorpay(
  body: Record<string, unknown>,
  status = 200,
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const captured = {
  status: "captured",
  amount: 1000,
  amount_refunded: 0,
  refund_status: null,
};

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
});

async function start(
  razorpay: typeof fetch,
  overrides: Partial<SignalServiceOptions> = {},
): Promise<string> {
  const options: SignalServiceOptions = {
    audience: AUDIENCE,
    parmanaPublicKeyPem: pem(parmana.publicKey),
    parmanaKeyId: "default",
    signingKeyPem: privatePem(signer.privateKey),
    signingKeyId: "signal-1",
    credential: SECRET,
    fetch: razorpay,
    now: () => NOW,
    ...overrides,
  };
  server = createSignalHttpServer(options);
  await new Promise<void>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve()),
  );
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  return fetch(base, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("Razorpay signal service", () => {
  it("answers a signed query with an observed value, signed by the service, echoing the query", async () => {
    const base = await start(fakeRazorpay(captured));
    const response = await post(base, signed(query()));

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as SignedSignalAnswer;
    expect(envelope.answer).toEqual({
      version: 1,
      source: "razorpay-payments",
      nonce: "nonce-1",
      signalKey: "payment.refundable",
      claim: "payment.refundable",
      subject: PAYMENT,
      status: "observed",
      value: true,
      observedAt: NOW.toISOString(),
      validUntil: "2026-11-08T10:01:00.000Z",
    });
    const ok = verify(
      null,
      Buffer.from(serializer.serialize(envelope.answer)),
      signer.publicKey,
      Buffer.from(envelope.signature.value, "base64"),
    );
    expect(ok).toBe(true);
    expect(envelope.signature.keyId).toBe("signal-1");
  });

  it("reports false, signed, when the payment cannot cover the amount", async () => {
    const base = await start(
      fakeRazorpay({
        ...captured,
        amount_refunded: 700,
        refund_status: "partial",
      }),
    );
    const envelope = (await (
      await post(base, signed(query({ parameters: { amount: 500 } })))
    ).json()) as SignedSignalAnswer;
    expect(envelope.answer).toMatchObject({ status: "observed", value: false });
  });

  it("reports not_found for a payment Razorpay does not have", async () => {
    const base = await start(fakeRazorpay({ error: {} }, 404));
    const response = await post(base, signed(query()));
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as SignedSignalAnswer).answer,
    ).toMatchObject({
      status: "not_found",
      reason: "Razorpay has no payment with this id",
    });
  });

  it("reports not_found when the query carries no refund amount, so the policy cannot pass", async () => {
    const base = await start(fakeRazorpay(captured));
    const envelope = (await (
      await post(base, signed(query({ parameters: undefined })))
    ).json()) as SignedSignalAnswer;
    expect(envelope.answer).toMatchObject({ status: "not_found" });
  });

  it("answers 503 when Razorpay fails, and never answers a fact it could not read", async () => {
    const base = await start(fakeRazorpay({ error: {} }, 500));
    const response = await post(base, signed(query()));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("super-secret-value");
  });

  it("refuses a query that is not signed by parmana-core's registered key", async () => {
    const other = generateKeyPairSync("ed25519");
    const base = await start(fakeRazorpay(captured));
    expect((await post(base, signed(query(), other.privateKey))).status).toBe(
      403,
    );
    expect(
      (await post(base, signed(query(), parmana.privateKey, "someone-else")))
        .status,
    ).toBe(403);
  });

  it("refuses a query whose content changed after signing", async () => {
    const base = await start(fakeRazorpay(captured));
    const body = signed(query());
    const tampered = {
      ...body,
      query: { ...body.query, parameters: { amount: 1 } },
    };
    expect((await post(base, tampered)).status).toBe(403);
  });

  it("refuses a query addressed to another audience or source", async () => {
    const base = await start(fakeRazorpay(captured));
    expect(
      (
        await post(
          base,
          signed(query({ audience: "https://elsewhere.example.com/x" })),
        )
      ).status,
    ).toBe(403);
    expect(
      (await post(base, signed(query({ source: "paytm-payments" })))).status,
    ).toBe(403);
  });

  it("refuses an expired query, and one that lives longer than 60 seconds", async () => {
    const base = await start(fakeRazorpay(captured));
    expect(
      (
        await post(
          base,
          signed(
            query({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          base,
          signed(
            query({
              expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
            }),
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("refuses a query with no nonce", async () => {
    const base = await start(fakeRazorpay(captured));
    expect((await post(base, signed(query({ nonce: "" })))).status).toBe(403);
  });

  it("refuses a request that is not a JSON POST, or is too large", async () => {
    const base = await start(fakeRazorpay(captured));
    expect((await fetch(base, { method: "GET" })).status).toBe(405);
    expect(
      (await post(base, "{}", { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await post(base, "not json")).status).toBe(400);
    expect((await post(base, "x".repeat(17 * 1024))).status).toBe(413);
  });
});
