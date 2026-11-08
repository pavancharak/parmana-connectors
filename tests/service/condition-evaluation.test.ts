import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorRequest, type GenericConnector } from "../../src/connector-contract.js";
import type { ConditionEvaluator } from "../../src/service/condition-evaluator.js";
import { MemoryReleaseLedger } from "../../src/service/release-ledger.js";
import { createService } from "../../src/service/server.js";

import { AUDIENCE, CAPABILITY, keys, release, signed } from "./helpers.js";

const PAYMENT = "pay_TestPayment01";
const REFUNDABLE = {
  signalKey: "payment.refundable",
  source: "razorpay",
  claim: "refundable",
  subject: PAYMENT,
  value: true,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
};

function withConditions(conditions: unknown[], id: string) {
  return signed(release({ businessTransactionId: id, conditions } as Partial<ReturnType<typeof release>>));
}

/** A service with one evaluator and a connector that records each call. */
async function start(evaluator: ConditionEvaluator | undefined) {
  const calls: ConnectorRequest[] = [];
  const connector: GenericConnector = {
    system: "razorpay",
    capabilities: [CAPABILITY],
    async execute(request) {
      calls.push(request);
      return { success: true, metadata: { status: 200, body: { refundId: "rfnd_1" } } };
    },
  };
  const ledger = new MemoryReleaseLedger();
  const service = createService({
    publicKey: keys.publicKey,
    audience: AUDIENCE,
    releaseLedger: ledger,
    connector,
    credentialId: "RAZORPAY_KEY_PAIR",
    resolveCredential: () => "rzp_test_abc:unused",
    timeoutMs: 10_000,
    conditionEvaluators: evaluator === undefined ? [] : [evaluator],
  });
  const server: Server = await service.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return { calls, post, close: () => server.close() };
}

const holds: ConditionEvaluator = {
  signalKey: "payment.refundable",
  atomicity: "check-then-act",
  async evaluate() {
    return { holds: true };
  },
};

const notHolding: ConditionEvaluator = {
  signalKey: "payment.refundable",
  atomicity: "check-then-act",
  async evaluate() {
    return {
      holds: false,
      reason: "the payment has been fully refunded",
      evidence: { source: "razorpay", status: "refunded", amount: 1000, amountRefunded: 1000 },
    };
  },
};

const holdsWithEvidence: ConditionEvaluator = {
  signalKey: "payment.refundable",
  atomicity: "check-then-act",
  async evaluate() {
    return { holds: true, evidence: { source: "razorpay", status: "captured", amount: 1000, amountRefunded: 0 } };
  },
};

const throws: ConditionEvaluator = {
  signalKey: "payment.refundable",
  atomicity: "check-then-act",
  async evaluate() {
    throw new ConnectorError("upstream_error", "Razorpay did not answer");
  },
};

describe("a release whose condition has an evaluator", () => {
  let running: Awaited<ReturnType<typeof start>> | undefined;
  afterAll(() => running?.close());

  it("calls the connector once when the condition holds, and records how it was checked", async () => {
    running = await start(holds);
    const result = await running.post(withConditions([REFUNDABLE], "btx-holds-1"));
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ success: true, conditionsChecked: [{ signalKey: "payment.refundable", atomicity: "check-then-act" }] });
    expect(running.calls).toHaveLength(1);
  });

  it("does not call the connector when the condition no longer holds, and says so", async () => {
    running = await start(notHolding);
    const result = await running.post(withConditions([REFUNDABLE], "btx-not-holding-1"));
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ success: false, conditionsNotMet: true });
    expect(running.calls).toHaveLength(0);
  });

  it("records the evidence for a condition that holds, in the answer", async () => {
    running = await start(holdsWithEvidence);
    const result = await running.post(withConditions([REFUNDABLE], "btx-holds-evidence-1"));
    expect(result.json.conditionsChecked).toEqual([
      {
        signalKey: "payment.refundable",
        atomicity: "check-then-act",
        outcome: "holds",
        evidence: { source: "razorpay", status: "captured", amount: 1000, amountRefunded: 0 },
      },
    ]);
  });

  it("keeps the evidence for a condition that does not hold, with the answer", async () => {
    running = await start(notHolding);
    const result = await running.post(withConditions([REFUNDABLE], "btx-not-holding-evidence-1"));
    expect(result.json.conditionsChecked).toEqual([
      {
        signalKey: "payment.refundable",
        atomicity: "check-then-act",
        outcome: "not-holding",
        evidence: { source: "razorpay", status: "refunded", amount: 1000, amountRefunded: 1000 },
      },
    ]);
  });

  it("gives a repeat of a not-met release the same answer, and still does not call the connector", async () => {
    running = await start(notHolding);
    const first = await running.post(withConditions([REFUNDABLE], "btx-not-holding-2"));
    const second = await running.post(withConditions([REFUNDABLE], "btx-not-holding-2"));
    expect(second.json).toEqual(first.json);
    expect(running.calls).toHaveLength(0);
  });

  it("does not call the connector when the condition cannot be verified, and does not claim it was not met", async () => {
    running = await start(throws);
    const result = await running.post(withConditions([REFUNDABLE], "btx-unverifiable-1"));
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ success: false });
    expect(result.json.conditionsNotMet).toBeUndefined();
    expect(result.json.conditionsChecked).toEqual([
      { signalKey: "payment.refundable", atomicity: "check-then-act", outcome: "unverified" },
    ]);
    expect(running.calls).toHaveLength(0);
  });
});

describe("a release whose condition has no evaluator", () => {
  let running: Awaited<ReturnType<typeof start>> | undefined;
  afterAll(() => running?.close());

  it("is refused before it is claimed, so it can be sent again", async () => {
    running = await start(undefined);
    const first = await running.post(withConditions([REFUNDABLE], "btx-no-evaluator-1"));
    expect(first.status).toBe(403);
    expect(running.calls).toHaveLength(0);
    // Not recorded: the same id, sent again with an evaluator in place, is not treated as a repeat.
    const again = await running.post(withConditions([REFUNDABLE], "btx-no-evaluator-1"));
    expect(again.status).toBe(403);
  });
});
