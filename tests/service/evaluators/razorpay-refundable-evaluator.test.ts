import { describe, expect, it } from "vitest";

import { createRazorpayRefundableEvaluator } from "../../../src/service/evaluators/razorpay-refundable-evaluator.js";
import type { ExternalRelease } from "../../../src/service/release.js";

const PAYMENT = "pay_TestPayment01";
const KEY = "rzp_test_abc123:secretvalue";

function release(amount: number): ExternalRelease {
  const now = Date.now();
  return {
    version: 1,
    connectorId: "ext-razorpay:refund",
    audience: "https://connector.example.com/execute",
    businessTransactionId: "btx-1",
    authorizationId: "auth-1",
    capability: "razorpay:refund",
    target: PAYMENT,
    parameters: { amount },
    policy: { name: "customer-refund", version: "1.2.0" },
    approvedBy: [],
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
}

const CONDITION = {
  signalKey: "payment.refundable",
  source: "razorpay",
  claim: "refundable",
  subject: PAYMENT,
  value: true,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
};

function fakePayment(body: unknown, status = 200) {
  const calls: { url: string; auth: string | null; redirect: RequestRedirect | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("authorization"), redirect: init?.redirect });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

describe("createRazorpayRefundableEvaluator", () => {
  it("declares its signal and that its check is check-then-act", () => {
    const evaluator = createRazorpayRefundableEvaluator({ credential: KEY, fetch: fakePayment({}).fetch });
    expect(evaluator.signalKey).toBe("payment.refundable");
    expect(evaluator.atomicity).toBe("check-then-act");
  });

  it("holds for a captured payment with enough unrefunded amount, and records the evidence", async () => {
    const payment = fakePayment({ status: "captured", amount: 1000, amount_refunded: 0, refund_status: null });
    const evaluator = createRazorpayRefundableEvaluator({ credential: KEY, fetch: payment.fetch, now: () => new Date("2026-11-08T00:00:00Z") });
    const verdict = await evaluator.evaluate(CONDITION, release(600));
    expect(verdict).toMatchObject({
      holds: true,
      evidence: { source: "razorpay", subject: PAYMENT, status: "captured", amount: 1000, amountRefunded: 0, requested: 600, observedAt: "2026-11-08T00:00:00.000Z" },
    });
    expect(payment.calls[0]?.url).toBe(`https://api.razorpay.com/v1/payments/${PAYMENT}`);
    expect(payment.calls[0]?.redirect).toBe("error");
  });

  it("does not hold when the payment is not captured", async () => {
    const payment = fakePayment({ status: "refunded", amount: 1000, amount_refunded: 1000, refund_status: "full" });
    const evaluator = createRazorpayRefundableEvaluator({ credential: KEY, fetch: payment.fetch });
    const verdict = await evaluator.evaluate(CONDITION, release(100));
    expect(verdict).toMatchObject({ holds: false, reason: 'the payment status is "refunded", not "captured"' });
  });

  it("does not hold when the unrefunded amount is less than the request", async () => {
    const payment = fakePayment({ status: "captured", amount: 1000, amount_refunded: 700, refund_status: "partial" });
    const evaluator = createRazorpayRefundableEvaluator({ credential: KEY, fetch: payment.fetch });
    const verdict = await evaluator.evaluate(CONDITION, release(500));
    expect(verdict).toMatchObject({ holds: false, reason: "300 paise remain refundable, 500 paise requested" });
  });

  it("throws when the payment cannot be read, so the condition is unverifiable rather than not met", async () => {
    const payment = fakePayment({ error: "server" }, 500);
    const evaluator = createRazorpayRefundableEvaluator({ credential: KEY, fetch: payment.fetch });
    await expect(evaluator.evaluate(CONDITION, release(100))).rejects.toThrow("HTTP 500");
  });

  it("throws when the response lacks the fields the check needs", async () => {
    const payment = fakePayment({ status: "captured" });
    const evaluator = createRazorpayRefundableEvaluator({ credential: KEY, fetch: payment.fetch });
    await expect(evaluator.evaluate(CONDITION, release(100))).rejects.toThrow("missing status, amount or amount_refunded");
  });

  it("throws when the condition is about a different payment than the release acts on", async () => {
    const payment = fakePayment({ status: "captured", amount: 1000, amount_refunded: 0 });
    const evaluator = createRazorpayRefundableEvaluator({ credential: KEY, fetch: payment.fetch });
    await expect(evaluator.evaluate({ ...CONDITION, subject: "pay_Other00001" }, release(100))).rejects.toThrow("not the release's payment");
    expect(payment.calls).toHaveLength(0);
  });

  it("refuses a live key unless live keys are allowed, when it is built", () => {
    expect(() => createRazorpayRefundableEvaluator({ credential: "rzp_live_abc123:secretvalue", fetch: fakePayment({}).fetch })).toThrow();
  });
});
