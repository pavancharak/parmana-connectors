import { createHash, sign } from "node:crypto";

import { CanonicalSerializer } from "@parmana/crypto";
import { describe, expect, it } from "vitest";

import { checkExternalRelease } from "../../src/service/release.js";

import { AUDIENCE, CAPABILITY, keys, release, signed } from "./helpers.js";

function check(body: ReturnType<typeof signed>, now = new Date()) {
  return checkExternalRelease(body, {
    publicKey: keys.publicKey,
    audience: AUDIENCE,
    capabilities: [CAPABILITY],
    now,
  });
}

describe("checkExternalRelease", () => {
  it("accepts a release that is signed, addressed to this endpoint, served, fresh and new", async () => {
    const result = await check(signed(release()));
    expect(result.valid).toBe(true);
  });

  it("refuses a release signed for another connector, even when its capability is served here", async () => {
    const result = await check(signed(release({ connectorId: "ext-paytm:refund" })));
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors).toEqual(['release.connectorId "ext-paytm:refund" is not "ext-razorpay:refund"']);
  });

  it("refuses the bare vendor name, which is not the identity parmana-core signs", async () => {
    const result = await check(signed(release({ connectorId: "razorpay" })));
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors).toEqual(['release.connectorId "razorpay" is not "ext-razorpay:refund"']);
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

  it("refuses a capability this endpoint does not serve, and accepts the same transaction when it is correct", async () => {
    const wrong = await check(signed(release({ capability: "paytm:refund" })));
    expect(wrong.valid).toBe(false);
    const right = await check(signed(release()));
    expect(right.valid).toBe(true);
  });

  it("refuses an expired release, allowing 30 seconds of clock difference", async () => {
    const issuedAt = new Date(Date.now() - 120_000).toISOString();
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    const result = await check(signed(release({ issuedAt, expiresAt })));
    expect(result).toMatchObject({ valid: false });
    expect(result.valid === false && result.errors[0]).toContain("the release expired at");

    const within = new Date(Date.now() - 10_000).toISOString();
    const withinIssued = new Date(Date.now() - 70_000).toISOString();
    expect((await check(signed(release({ issuedAt: withinIssued, expiresAt: within })))).valid).toBe(true);
  });

  it("refuses a release issued in the future beyond the 30 second clock skew", async () => {
    const issuedAt = new Date(Date.now() + 120_000).toISOString();
    const expiresAt = new Date(Date.now() + 180_000).toISOString();
    const result = await check(signed(release({ issuedAt, expiresAt })));
    expect(result.valid === false && result.errors[0]).toContain("issued in the future");
  });

  it("refuses a release whose lifetime is longer than 60 seconds", async () => {
    // One clock reading for both times: two readings can straddle a millisecond and change the lifetime.
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 120_000).toISOString();
    const result = await check(signed(release({ issuedAt, expiresAt })));
    expect(result.valid === false && result.errors[0]).toContain("the release lifetime is 120 s; the limit is 60 s");
  });

  it("refuses a release whose expiresAt is not after issuedAt", async () => {
    const issuedAt = new Date(Date.now()).toISOString();
    const expiresAt = new Date(Date.now() - 5_000).toISOString();
    const result = await check(signed(release({ issuedAt, expiresAt })));
    expect(result.valid === false && result.errors).toContain("release.expiresAt must be after release.issuedAt");
  });

  it("does not refuse a repeat, because the release ledger answers repeats with the first answer (G-132)", async () => {
    expect((await check(signed(release()))).valid).toBe(true);
    expect((await check(signed(release()))).valid).toBe(true);
  });

  it("accepts a large release signed as a SHA-512 commitment, as parmana-core does above 4096 bytes (G-131)", async () => {
    const big = release({ parameters: { note: "x".repeat(5000) } });
    const bytes = new CanonicalSerializer().serialize(big);
    expect(bytes.length).toBeGreaterThan(4096);
    const commitment = Buffer.concat([
      Buffer.from("PARMANA-ED25519-LARGE-MESSAGE-V1\0", "utf8"),
      createHash("sha512").update(bytes).digest(),
    ]);
    const body = {
      release: big,
      signature: { algorithm: "ed25519", keyId: "default", value: sign(null, commitment, keys.privateKey).toString("base64") },
    };
    expect((await check(body)).valid).toBe(true);
  });

  it("refuses a commitment signature over a small release, so a commitment cannot stand in for a short message", async () => {
    const small = release();
    const bytes = new CanonicalSerializer().serialize(small);
    expect(bytes.length).toBeLessThanOrEqual(4096);
    const commitment = Buffer.concat([
      Buffer.from("PARMANA-ED25519-LARGE-MESSAGE-V1\0", "utf8"),
      createHash("sha512").update(bytes).digest(),
    ]);
    const body = {
      release: small,
      signature: { algorithm: "ed25519", keyId: "default", value: sign(null, commitment, keys.privateKey).toString("base64") },
    };
    expect(await check(body)).toMatchObject({ valid: false, errors: ["the signature does not verify"] });
  });
});
