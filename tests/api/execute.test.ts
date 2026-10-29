import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Vercel adapter, run behind a real HTTP server. Only paths that never reach
 * Razorpay are used here: a successful release would make a real refund call.
 */
describe("api/execute adapter", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "parmana-api-"));
    const publicKeyPath = join(dir, "parmana.pub.pem");
    const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    writeFileSync(publicKeyPath, pem);

    process.env.PARMANA_CONNECTOR = "razorpay";
    process.env.RAZORPAY_KEY_PAIR = "rzp_test_adapter:secret-for-tests";
    process.env.PARMANA_PUBLIC_KEY_FILE = publicKeyPath;
    process.env.PARMANA_RELEASE_AUDIENCE = "https://connector.example.com/api/execute";
    process.env.PARMANA_NONCE_STORE = "memory";

    const { default: handler } = await import("../../api/execute.js");
    server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers health under the /api prefix", async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UP" });
  });

  it("returns 404 for a route the service does not serve", async () => {
    const response = await fetch(`${base}/api/unknown`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("reaches the service for /api/execute and refuses a body that is not a release", async () => {
    const response = await fetch(`${base}/api/execute`, { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body is not a signed release" });
  });
});
