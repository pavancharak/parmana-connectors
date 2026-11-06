/**
 * Acceptance test: a refund proposed by an agent running in Google AX reaches
 * the connector only as a release that parmana-core has signed.
 *
 * What this test covers: the connector side of the boundary. It runs the real
 * service (createService) with a fake Razorpay-style connector, and submits
 * releases the way parmana-core does. The connector must run an authorized
 * refund once, and refuse everything else without running the connector.
 *
 * What it does not cover: the approval and revocation decisions. Those are made
 * by parmana-core's policy and approval checks before core signs a release, and
 * they are not in this repository. The release here is signed by a test key,
 * standing in for core. See README.md.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectorError,
  type ConnectorRequest,
  type GenericConnector,
} from "../../src/connector-contract.js";
import { MemoryNonceStore } from "../../src/service/nonce-store.js";
import { createService } from "../../src/service/server.js";
import {
  AUDIENCE,
  CAPABILITY,
  keys,
  release,
  signed,
} from "../../tests/service/helpers.js";

const SECRET = "rzp_test_abc:refund-acceptance-secret";
const TARGET = "pay_TestPayment01";

/** Stand-in for the AX-hosted agent: it proposes a refund and submits the release core signed. */
async function submitToConnector(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Harness {
  readonly base: string;
  readonly calls: ConnectorRequest[];
  close(): void;
}

async function startHarness(): Promise<Harness> {
  const calls: ConnectorRequest[] = [];
  const connector: GenericConnector = {
    system: "razorpay",
    capabilities: [CAPABILITY],
    async execute(request) {
      calls.push(request);
      if (request.target !== TARGET) {
        throw new ConnectorError("invalid_input", "unexpected refund target");
      }
      return { success: true, metadata: { status: 200, body: { refundId: "rfnd_1" } } };
    },
  };
  const service = createService({
    publicKey: keys.publicKey,
    audience: AUDIENCE,
    nonceStore: new MemoryNonceStore(),
    connector,
    credentialId: "RAZORPAY_KEY_PAIR",
    resolveCredential: () => SECRET,
    timeoutMs: 10_000,
  });
  const server: Server = await service.listen(0, "127.0.0.1");
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => server.close(),
  };
}

let harness: Harness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
});

async function ready(): Promise<Harness> {
  harness = await startHarness();
  return harness;
}

describe("refund proposed from Google AX", () => {
  it("runs an authorized refund once and returns the connector's result", async () => {
    const h = await ready();
    const response = await submitToConnector(h.base, signed(release({ target: TARGET, parameters: { amount: 75_000 } })));
    expect(response.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.parameters).toEqual({ amount: 75_000 });
  });

  it("refuses the same authorized release a second time without running the connector again", async () => {
    const h = await ready();
    const body = signed(release({ target: TARGET, parameters: { amount: 75_000 } }));
    expect((await submitToConnector(h.base, body)).status).toBe(200);
    expect((await submitToConnector(h.base, body)).status).toBe(403);
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a release signed by a key other than parmana-core's, and runs nothing", async () => {
    const h = await ready();
    const forger = generateKeyPairSync("ed25519");
    const response = await submitToConnector(
      h.base,
      signed(release({ target: TARGET }), forger.privateKey),
    );
    expect(response.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a release whose body was changed after signing, and runs nothing", async () => {
    const h = await ready();
    const tampered = signed(release({ target: TARGET, parameters: { amount: 1_000 } }));
    // The amount is raised after core signed the release.
    const altered = { ...tampered, release: { ...tampered.release, parameters: { amount: 900_000 } } };
    const response = await submitToConnector(h.base, altered);
    expect(response.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a release addressed to another endpoint, and runs nothing", async () => {
    const h = await ready();
    const response = await submitToConnector(
      h.base,
      signed(release({ target: TARGET, audience: "https://other.example.com/execute" })),
    );
    expect(response.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an expired release, and runs nothing", async () => {
    const h = await ready();
    const issuedAtMs = Date.now() - 10 * 60_000;
    const response = await submitToConnector(
      h.base,
      signed(
        release({
          target: TARGET,
          issuedAt: new Date(issuedAtMs).toISOString(),
          expiresAt: new Date(issuedAtMs + 60_000).toISOString(),
        }),
      ),
    );
    expect(response.status).not.toBe(200);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a release that lives longer than parmana-core issues, and runs nothing", async () => {
    const h = await ready();
    const issuedAtMs = Date.now();
    const response = await submitToConnector(
      h.base,
      signed(
        release({
          target: TARGET,
          issuedAt: new Date(issuedAtMs).toISOString(),
          expiresAt: new Date(issuedAtMs + 10 * 60_000).toISOString(),
        }),
      ),
    );
    expect(response.status).not.toBe(200);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a capability this connector does not serve, and runs nothing", async () => {
    const h = await ready();
    const response = await submitToConnector(
      h.base,
      signed(release({ target: TARGET, capability: "razorpay:payout" })),
    );
    expect(response.status).not.toBe(200);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a body that is not a signed release, and runs nothing", async () => {
    const h = await ready();
    const response = await submitToConnector(h.base, { hello: "agent" });
    expect(response.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });
});
