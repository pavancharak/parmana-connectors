import { describe, expect, it } from "vitest";

import { MemoryNonceStore } from "../../src/service/nonce-store.js";
import { verifyExternalRelease } from "../../src/service/release.js";

import { AUDIENCE, CAPABILITY, keys, release, signed } from "./helpers.js";

function check(body: ReturnType<typeof signed>, store = new MemoryNonceStore(), now = new Date()) {
  return verifyExternalRelease(body, {
    publicKey: keys.publicKey,
    audience: AUDIENCE,
    capabilities: [CAPABILITY],
    now,
    nonceStore: store,
  });
}

describe("verifyExternalRelease", () => {
  it("accepts a release that is signed, addressed to this endpoint, served, fresh and new", async () => {
    const result = await check(signed(release()));
    expect(result.valid).toBe(true);
  });

  it("refuses a release whose content changed after signing", async () => {
    const body = signed(release());
    const tampered = { ...body, release: { ...body.release, parameters: { amount: 999999 } } };
    const result = await check(tampered);
    expect(result).toMatchObject({ valid: false, errors: ["the signature does not verify"] });
  });

  it("refuses a release signed by another key", async () => {
    const other = (await import("node:crypto")).generateKeyPairSync("ed25519");
    const result = await check(signed(release(), other.privateKey));
    expect(result).toMatchObject({ valid: false, errors: ["the signature does not verify"] });
  });

  it("refuses a release addressed to another endpoint", async () => {
    const result = await check(signed(release({ audience: "https://elsewhere.example.com/execute" })));
    expect(result.valid).toBe(false);
  });

  it("refuses a capability this endpoint does not serve, without using up the transaction", async () => {
    const store = new MemoryNonceStore();
    const wrong = await check(signed(release({ capability: "paytm:refund" })), store);
    expect(wrong.valid).toBe(false);
    const right = await check(signed(release()), store);
    expect(right.valid).toBe(true);
  });

  it("refuses an expired release, allowing 30 seconds of clock difference", async () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    const result = await check(signed(release({ expiresAt })));
    expect(result).toMatchObject({ valid: false });
    const within = new Date(Date.now() - 10_000).toISOString();
    expect((await check(signed(release({ expiresAt: within })))).valid).toBe(true);
  });

  it("refuses a second release for the same transaction", async () => {
    const store = new MemoryNonceStore();
    expect((await check(signed(release()), store)).valid).toBe(true);
    const again = await check(signed(release()), store);
    expect(again).toMatchObject({ valid: false, errors: ["this businessTransactionId was already executed"] });
  });
});
