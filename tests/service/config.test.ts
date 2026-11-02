import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ConfigError, loadServiceConfig } from "../../src/service/config.js";

const ed25519 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();

const readers = {
  readFile: (path: string) => {
    if (path === "/keys/parmana.pem") return ed25519;
    if (path === "/keys/rsa.pem") return rsa;
    throw new Error(`no such file: ${path}`);
  },
};

const TEST_KEY = "rzp_test_abc123:secret-value";
const LIVE_KEY = "rzp_live_abc123:secret-value";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PARMANA_CONNECTOR: "razorpay",
    RAZORPAY_KEY_PAIR: TEST_KEY,
    PARMANA_PUBLIC_KEY_FILE: "/keys/parmana.pem",
    PARMANA_RELEASE_AUDIENCE: "https://connector.example.com/execute",
    PARMANA_DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/parmana",
    ...overrides,
  };
}

function refusal(overrides: Record<string, string | undefined>): string {
  try {
    loadServiceConfig(env(overrides), readers);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected the configuration to be refused");
}

describe("loadServiceConfig", () => {
  it("accepts a complete configuration and applies the defaults", () => {
    const config = loadServiceConfig(env(), readers);
    expect(config).toMatchObject({ port: 8080, host: "127.0.0.1", connector: "razorpay", allowLiveKeys: false, nonceStore: "postgres" });
  });

  it("refuses a missing connector, and names the allowed ones", () => {
    expect(refusal({ PARMANA_CONNECTOR: undefined })).toBe("PARMANA_CONNECTOR is required");
    expect(refusal({ PARMANA_CONNECTOR: "stripe" })).toBe("PARMANA_CONNECTOR must be one of: paytm, razorpay");
  });

  it("accepts paytm with a valid merchant credential, and names the variable when it is missing", () => {
    const config = loadServiceConfig(env({ PARMANA_CONNECTOR: "paytm", RAZORPAY_KEY_PAIR: undefined, PAYTM_MERCHANT_CREDENTIAL: "MERCHANT123456789:abcdefghijklmnop" }), readers);
    expect(config).toMatchObject({ connector: "paytm" });
    expect(refusal({ PARMANA_CONNECTOR: "paytm", RAZORPAY_KEY_PAIR: undefined, PAYTM_MERCHANT_CREDENTIAL: undefined })).toBe("PAYTM_MERCHANT_CREDENTIAL is required");
  });

  it("refuses a paytm merchant key that is not 16 bytes, without echoing it", () => {
    const message = refusal({ PARMANA_CONNECTOR: "paytm", RAZORPAY_KEY_PAIR: undefined, PAYTM_MERCHANT_CREDENTIAL: "MERCHANT123:short-key" });
    expect(message).toContain("PAYTM_MERCHANT_CREDENTIAL cannot be used");
    expect(message).not.toContain("short-key");
  });

  it("refuses a missing credential, naming the variable and not a value", () => {
    expect(refusal({ RAZORPAY_KEY_PAIR: undefined })).toBe("RAZORPAY_KEY_PAIR is required");
  });

  it("refuses a malformed credential without echoing it", () => {
    const message = refusal({ RAZORPAY_KEY_PAIR: "not-a-key-pair" });
    expect(message).toContain("RAZORPAY_KEY_PAIR cannot be used");
    expect(message).not.toContain("not-a-key-pair");
  });

  it("refuses a live key unless live keys are allowed", () => {
    expect(refusal({ RAZORPAY_KEY_PAIR: LIVE_KEY })).toContain("live Razorpay keys are refused");
    const config = loadServiceConfig(env({ RAZORPAY_KEY_PAIR: LIVE_KEY, PARMANA_ALLOW_LIVE_KEYS: "true" }), readers);
    expect(config.allowLiveKeys).toBe(true);
  });

  it("refuses a release audience that is not https", () => {
    expect(refusal({ PARMANA_RELEASE_AUDIENCE: "http://connector.example.com/execute" })).toBe(
      "PARMANA_RELEASE_AUDIENCE must use https://",
    );
    expect(refusal({ PARMANA_RELEASE_AUDIENCE: undefined })).toBe("PARMANA_RELEASE_AUDIENCE is required");
  });

  it("refuses a public key that is not Ed25519", () => {
    expect(refusal({ PARMANA_PUBLIC_KEY_FILE: "/keys/rsa.pem" })).toBe("PARMANA_PUBLIC_KEY_FILE must be an Ed25519 public key");
  });

  it("accepts the key as PARMANA_PUBLIC_KEY, with literal \\n sequences turned into line breaks", () => {
    const escaped = ed25519.replace(/\n/g, "\\n");
    const config = loadServiceConfig(env({ PARMANA_PUBLIC_KEY_FILE: undefined, PARMANA_PUBLIC_KEY: escaped }), readers);
    expect(config.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("refuses a PARMANA_PUBLIC_KEY that is not Ed25519, naming the variable", () => {
    expect(refusal({ PARMANA_PUBLIC_KEY_FILE: undefined, PARMANA_PUBLIC_KEY: rsa })).toBe(
      "PARMANA_PUBLIC_KEY must be an Ed25519 public key",
    );
  });

  it("refuses a public key given both ways, and a missing one", () => {
    expect(refusal({ PARMANA_PUBLIC_KEY: ed25519 })).toBe("set either PARMANA_PUBLIC_KEY or PARMANA_PUBLIC_KEY_FILE, not both");
    expect(refusal({ PARMANA_PUBLIC_KEY_FILE: undefined })).toBe("PARMANA_PUBLIC_KEY or PARMANA_PUBLIC_KEY_FILE is required");
  });

  it("requires a database for the postgres store, and allows memory only when asked for", () => {
    expect(refusal({ PARMANA_DATABASE_URL: undefined })).toBe("PARMANA_DATABASE_URL is required");
    const config = loadServiceConfig(env({ PARMANA_NONCE_STORE: "memory", PARMANA_DATABASE_URL: undefined }), readers);
    expect(config.nonceStore).toBe("memory");
  });

  it("refuses a port outside the valid range", () => {
    expect(refusal({ PARMANA_SERVICE_PORT: "70000" })).toBe("PARMANA_SERVICE_PORT must be an integer from 1 to 65535");
  });
});
