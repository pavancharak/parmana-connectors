import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { CanonicalSerializer } from "@parmana/crypto";

import type { ExternalRelease, SignedExternalRelease } from "../../src/service/release.js";

export const AUDIENCE = "https://connector.example.com/execute";
export const CAPABILITY = "razorpay:refund";
export const TRANSACTION = "txn-service-1";

export const keys = generateKeyPairSync("ed25519");

export function release(overrides: Partial<ExternalRelease> = {}): ExternalRelease {
  return {
    version: 1,
    connectorId: "razorpay",
    audience: AUDIENCE,
    businessTransactionId: TRANSACTION,
    authorizationId: "auth-1",
    capability: CAPABILITY,
    target: "pay_TestPayment01",
    parameters: { amount: 100 },
    policy: { name: "customer-refund", version: "1.2.0" },
    approvedBy: [],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

/** Signs a release the way parmana-core does: Ed25519 over the canonical serialization. */
export function signed(rel: ExternalRelease, privateKey: KeyObject = keys.privateKey): SignedExternalRelease {
  const bytes = new CanonicalSerializer().serialize(rel);
  return {
    release: rel,
    signature: { algorithm: "ed25519", keyId: "default", value: sign(null, bytes, privateKey).toString("base64") },
  };
}
