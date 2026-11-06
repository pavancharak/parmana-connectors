import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { checkConfig } from "../../src/service/check-config.js";

const ed25519 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const readFile = (path: string) => {
  if (path === "/keys/parmana.pem") return ed25519;
  throw new Error(`no such file: ${path}`);
};

const TEST_KEY = "rzp_test_abc123:secret-value";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PARMANA_CONNECTOR: "razorpay",
    RAZORPAY_KEY_PAIR: TEST_KEY,
    PARMANA_PUBLIC_KEY_FILE: "/keys/parmana.pem",
    PARMANA_RELEASE_AUDIENCE: "https://connector.example.com/execute",
    PARMANA_NONCE_STORE: "memory",
    ...overrides,
  };
}

describe("checkConfig", () => {
  it("accepts a complete configuration and names the connector without the secret", () => {
    const result = checkConfig(env(), readFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain("connector: razorpay");
      expect(result.summary).not.toContain("secret-value");
      expect(result.summary).not.toContain(TEST_KEY);
    }
  });

  it("names the first missing setting", () => {
    const result = checkConfig(env({ RAZORPAY_KEY_PAIR: undefined }), readFile);
    expect(result).toEqual({ ok: false, reason: "RAZORPAY_KEY_PAIR is required" });
  });

  it("refuses a missing release audience", () => {
    const result = checkConfig(env({ PARMANA_RELEASE_AUDIENCE: undefined }), readFile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("PARMANA_RELEASE_AUDIENCE");
  });

  it("reports an unreadable public key file as a setting problem", () => {
    const result = checkConfig(env({ PARMANA_PUBLIC_KEY_FILE: "/keys/missing.pem" }), readFile);
    expect(result).toEqual({ ok: false, reason: "the file named by PARMANA_PUBLIC_KEY_FILE could not be read" });
  });

  it("refuses a Razorpay key that is not in the expected form, without echoing it", () => {
    const result = checkConfig(env({ RAZORPAY_KEY_PAIR: "not-a-key" }), readFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("RAZORPAY_KEY_PAIR");
      expect(result.reason).not.toContain("not-a-key");
    }
  });
});
