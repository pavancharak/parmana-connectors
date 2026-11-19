import { describe, expect, it, vi } from "vitest";

import {
  answerPaymentRefundable,
  SignalUnavailableError,
} from "../../src/signal/razorpay-payment-signal.js";
import type { SignalQueryMessage } from "../../src/signal/protocol.js";

/**
 * Cases ported from parmana-core's payment source tests (`razorpay-payment-source.test.ts`), which
 * were removed from core when the source was confirmed to be a duplicate of this signal. Behaviour
 * here matches the core copy: a wrong claim or a missing amount throws (a configuration or query error),
 * and a payment Razorpay does not have is `not_found`.
 */

const CREDENTIAL = "rzp_test_keyid:keysecret";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function query(over: Partial<SignalQueryMessage> = {}): SignalQueryMessage {
  return {
    version: 1,
    source: "razorpay",
    audience: "https://signal.example.test/signal",
    signalKey: "payment.refundable",
    claim: "payment.refundable",
    subject: "pay_ABC123456",
    action: "payments:refund",
    businessTransactionId: "btx-1",
    nonce: "nonce-1",
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    parameters: { amount: 6_000_000 },
    ...over,
  } as SignalQueryMessage;
}

function payment(body: Record<string, unknown>, status = 200) {
  const fetch = vi.fn(
    async () =>
      ({
        status,
        json: async () => body,
      }) as unknown as Response,
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, spy: fetch };
}

const captured = {
  status: "captured",
  amount: 10_000_000,
  amount_refunded: 0,
  refund_status: null,
};

describe("payment.refundable from Razorpay's own record", () => {
  it("holds for a captured payment with the amount still refundable, valid for 60 seconds", async () => {
    const { fetch } = payment(captured);
    const answer = await answerPaymentRefundable(query(), {
      credential: CREDENTIAL,
      fetch,
      now: () => NOW,
    });
    expect(answer).toMatchObject({
      status: "observed",
      value: true,
      observedAt: NOW.toISOString(),
      validUntil: new Date(NOW.getTime() + 60_000).toISOString(),
    });
  });

  it("does not hold when the payment is not captured", async () => {
    const { fetch } = payment({ ...captured, status: "authorized" });
    const answer = await answerPaymentRefundable(query(), {
      credential: CREDENTIAL,
      fetch,
      now: () => NOW,
    });
    expect(answer).toMatchObject({ status: "observed", value: false });
  });

  it("does not hold when the payment is fully refunded, even if its status is captured", async () => {
    const { fetch } = payment({ ...captured, refund_status: "full" });
    const answer = await answerPaymentRefundable(query(), {
      credential: CREDENTIAL,
      fetch,
      now: () => NOW,
    });
    expect(answer).toMatchObject({ status: "observed", value: false });
  });

  it("does not hold when less than the requested amount remains", async () => {
    const { fetch } = payment({ ...captured, amount_refunded: 5_000_000 });
    const answer = await answerPaymentRefundable(query({ parameters: { amount: 6_000_000 } }), {
      credential: CREDENTIAL,
      fetch,
      now: () => NOW,
    });
    expect(answer).toMatchObject({ status: "observed", value: false });
  });

  it("answers not_found for a payment Razorpay does not have", async () => {
    const { fetch } = payment({}, 404);
    const answer = await answerPaymentRefundable(query(), {
      credential: CREDENTIAL,
      fetch,
      now: () => NOW,
    });
    expect(answer).toMatchObject({ status: "not_found" });
  });

  it("answers not_found for a subject that is not a Razorpay payment id, without calling Razorpay", async () => {
    const { fetch, spy } = payment(captured);
    const answer = await answerPaymentRefundable(query({ subject: "order_123" }), {
      credential: CREDENTIAL,
      fetch,
      now: () => NOW,
    });
    expect(answer).toMatchObject({ status: "not_found" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when Razorpay fails, and never includes the credential in the error", async () => {
    const { fetch } = payment({ error: "boom" }, 500);
    const error = await answerPaymentRefundable(query(), {
      credential: CREDENTIAL,
      fetch,
      now: () => NOW,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignalUnavailableError);
    expect(String((error as Error).message)).not.toContain("keysecret");
  });

  it("throws when the read is missing a field the check needs", async () => {
    const { fetch } = payment({ status: "captured", amount: 10_000_000 });
    await expect(
      answerPaymentRefundable(query(), { credential: CREDENTIAL, fetch, now: () => NOW }),
    ).rejects.toThrow(SignalUnavailableError);
  });

  it("throws for a claim it does not establish, as a configuration error, without calling Razorpay", async () => {
    const { fetch, spy } = payment(captured);
    await expect(
      answerPaymentRefundable(
        query({ claim: "order.shipped", signalKey: "order.shipped" }),
        { credential: CREDENTIAL, fetch, now: () => NOW },
      ),
    ).rejects.toThrow(SignalUnavailableError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when the refund amount is missing or not a positive whole number of paise, without calling Razorpay", async () => {
    const { fetch, spy } = payment(captured);
    for (const parameters of [{}, { amount: 0 }, { amount: 1.5 }, { amount: -5 }]) {
      await expect(
        answerPaymentRefundable(query({ parameters }), {
          credential: CREDENTIAL,
          fetch,
          now: () => NOW,
        }),
      ).rejects.toThrow(SignalUnavailableError);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
