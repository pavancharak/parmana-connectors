import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadSignalConfig } from "../../src/signal/config.js";

const keys = generateKeyPairSync("ed25519");
const pem = (key: "publicKey" | "privateKey") =>
  keys[key]
    .export(
      key === "publicKey"
        ? { type: "spki", format: "pem" }
        : { type: "pkcs8", format: "pem" },
    )
    .toString();

const complete = {
  PARMANA_SIGNAL_AUDIENCE: "https://signal.example.com/refund-payment",
  PARMANA_SIGNAL_PARMANA_PUBLIC_KEY_PEM: pem("publicKey"),
  PARMANA_SIGNAL_SIGNING_KEY_PEM: pem("privateKey"),
  RAZORPAY_CORE_READ_KEY: "rzp_test_keyid:secret",
};

describe("loadSignalConfig", () => {
  it("uses the source name from PARMANA_SIGNAL_SOURCE_NAME, and the default when it is unset", () => {
    expect(loadSignalConfig({ ...complete, PARMANA_SIGNAL_SOURCE_NAME: "razorpay" }).source).toBe("razorpay");
    expect(loadSignalConfig(complete).source).toBeUndefined();
  });

  it("refuses a source name that is not lowercase letters, digits and hyphens", () => {
    expect(() => loadSignalConfig({ ...complete, PARMANA_SIGNAL_SOURCE_NAME: "Razorpay Payments" })).toThrow(
      "PARMANA_SIGNAL_SOURCE_NAME must be",
    );
  });

  it("loads a complete configuration, with the documented defaults", () => {
    const config = loadSignalConfig(complete);
    expect(config.audience).toBe("https://signal.example.com/refund-payment");
    expect(config.parmanaKeyId).toBe("default");
    expect(config.signingKeyId).toBe("signal-1");
    expect(config.credential).toBe("rzp_test_keyid:secret");
  });

  it.each([
    "PARMANA_SIGNAL_AUDIENCE",
    "PARMANA_SIGNAL_PARMANA_PUBLIC_KEY_PEM",
    "PARMANA_SIGNAL_SIGNING_KEY_PEM",
    "RAZORPAY_CORE_READ_KEY",
  ])("refuses to start without %s", (name) => {
    const env = { ...complete, [name]: "  " };
    expect(() => loadSignalConfig(env)).toThrow(`${name} is required`);
  });

  it("refuses an audience that is not https", () => {
    expect(() =>
      loadSignalConfig({
        ...complete,
        PARMANA_SIGNAL_AUDIENCE: "http://signal.example.com/x",
      }),
    ).toThrow("must be an https URL");
  });

  it("refuses a malformed Razorpay key", () => {
    expect(() =>
      loadSignalConfig({ ...complete, RAZORPAY_CORE_READ_KEY: "no-colon" }),
    ).toThrow();
  });
});
