import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConnectorError, type ConnectorRequest, type GenericConnector } from "../../src/connector-contract.js";
import { MemoryReleaseLedger, type ReleaseLedger } from "../../src/service/release-ledger.js";
import { createService } from "../../src/service/server.js";

import { AUDIENCE, CAPABILITY, keys, release, signed } from "./helpers.js";

const SECRET = "rzp_test_abc:super-secret-value";

function fakeConnector(outcome: "ok" | "fail", log: ConnectorRequest[]): GenericConnector {
  return {
    system: "razorpay",
    capabilities: [CAPABILITY],
    async execute(request) {
      log.push(request);
      if (outcome === "fail") throw new ConnectorError("upstream_error", "Razorpay refused the refund");
      return { success: true, metadata: { status: 200, body: { refundId: "rfnd_1" } } };
    },
  };
}

let server: Server;
let base: string;
let calls: ConnectorRequest[] = [];
let ledger: ReleaseLedger = new MemoryReleaseLedger();
let behaviour: "ok" | "fail" = "ok";

// One connector and one store for the whole run. Each test swaps what they delegate to.
const connector: GenericConnector = {
  system: "razorpay",
  capabilities: [CAPABILITY],
  execute: (request, context) => fakeConnector(behaviour, calls).execute(request, context),
};
const delegatingLedger: ReleaseLedger = {
  claim: (id, expiresAt) => ledger.claim(id, expiresAt),
  complete: (id, answer) => ledger.complete(id, answer),
};

beforeAll(async () => {
  const service = createService({
    publicKey: keys.publicKey,
    audience: AUDIENCE,
    releaseLedger: delegatingLedger,
    connector,
    credentialId: "RAZORPAY_KEY_PAIR",
    resolveCredential: () => SECRET,
    timeoutMs: 10_000,
    // The refund's payment check. These tests cover execution, so the check holds here; the condition
    // tests cover the check itself.
    conditionEvaluators: [
      { signalKey: "payment.refundable", atomicity: "check-then-act", evaluate: async () => ({ holds: true }) },
    ],
  });
  server = await service.listen(0, "127.0.0.1");
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

function reset(next: "ok" | "fail" = "ok") {
  ledger = new MemoryReleaseLedger();
  behaviour = next;
  calls = [];
}

async function post(body: unknown, raw?: string) {
  return fetch(`${base}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

describe("the service", () => {
  it("answers health without checking anything upstream", async () => {
    reset();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UP" });
  });

  it("runs an approved release once and answers with the contract's fields", async () => {
    reset();
    const response = await post(signed(release()));
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ businessTransactionId: "txn-service-1", capability: CAPABILITY, success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: "pay_TestPayment01", businessTransactionId: "txn-service-1", parameters: { amount: 100 } });
  });

  it("answers a repeat with the first answer, and does not run the connector again (G-132)", async () => {
    reset();
    const first = await post(signed(release()));
    const firstBody = await first.text();
    const again = await post(signed(release()));
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(firstBody);
    expect(calls).toHaveLength(1);
  });

  it("returns the connector's failure with its code only, never the detail or the credential", async () => {
    reset("fail");
    const response = await post(signed(release()));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ success: false, result: { error: "connector failed: upstream_error" } });
    expect(text).not.toContain("Razorpay refused");
    expect(text).not.toContain("super-secret-value");
  });

  it("logs the connector's message for a failure, and never the credential", async () => {
    reset("fail");
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await post(signed(release()));
    } finally {
      spy.mockRestore();
    }
    const line = written.map((text) => JSON.parse(text) as Record<string, unknown>).find((entry) => entry.event === "connector_failed");
    expect(line).toMatchObject({ code: "upstream_error", detail: "Razorpay refused the refund" });
    expect(written.join("")).not.toContain("super-secret-value");
  });

  it("refuses a release with a bad signature and does not run the connector", async () => {
    reset();
    const body = signed(release());
    const response = await post({ ...body, release: { ...body.release, amount: 1 } });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body that is not a signed release", async () => {
    reset();
    expect((await post({ hello: "world" })).status).toBe(400);
    expect((await post(undefined, "not json")).status).toBe(400);
  });

  it("refuses a body larger than the limit", async () => {
    reset();
    const big = "x".repeat(300 * 1024);
    expect((await post(undefined, JSON.stringify({ release: { pad: big }, signature: {} }))).status).toBe(413);
  });

  it("answers 404 for any other route or method", async () => {
    reset();
    expect((await fetch(`${base}/nowhere`)).status).toBe(404);
    expect((await fetch(`${base}/execute`)).status).toBe(404);
  });

  it("answers 500 and runs nothing when the release ledger is unavailable", async () => {
    reset();
    ledger = {
      claim: async () => {
        throw new Error("database unreachable");
      },
      complete: async () => undefined,
    };
    const response = await post(signed(release()));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("database unreachable");
    expect(calls).toHaveLength(0);
  });
});
