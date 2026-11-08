import { createHash, verify, type KeyObject } from "node:crypto";

import { CanonicalSerializer } from "@parmana/crypto";
import { expectedConnectorId } from "./connector-identity.js";

/**
 * parmana-core's external connector protocol (ADR-0013). Parmana POSTs
 * { release, signature } to the registered endpoint. The signature is the
 * authentication: the release is refused unless it verifies against Parmana's
 * public key, names this endpoint as its audience, names a capability this
 *  endpoint serves, and has not expired. Replay is not checked here: the caller
 * records each release in the release ledger, which returns the first answer to a
 * repeat (G-132).
 */

/**
 * Above this many bytes, parmana-core signs a release as a SHA-512 commitment of its
 * canonical bytes, not the raw bytes (packages/crypto/src/SignatureCommitment.ts,
 * ADR-0010). The limit and the prefix must match parmana-core exactly (G-131).
 */
const KMS_RAW_MESSAGE_LIMIT_BYTES = 4096;
const COMMITMENT_PREFIX = Buffer.from("PARMANA-ED25519-LARGE-MESSAGE-V1\0", "utf8");

/** Key id Parmana signs releases with. */
export const RELEASE_KEY_ID = "default";

/** How far the clock may be behind before an expired release is refused, in milliseconds. */
const CLOCK_SKEW_MS = 30_000;

/**
 * Longest lifetime a release may have, from issuedAt to expiresAt. parmana-core
 * issues releases with a 60 s TTL (EXTERNAL_RELEASE_TTL_MS in execution-gateway)
 * and only shortens them, so a longer one was not issued by it.
 */
const MAX_RELEASE_LIFETIME_MS = 60_000;

export interface ExternalRelease {
  readonly version: 1;
  readonly connectorId: string;
  readonly audience: string;
  readonly businessTransactionId: string;
  readonly authorizationId: string;
  readonly capability: string;
  readonly target: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly approvedBy: readonly unknown[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly conditions?: readonly unknown[];
}

export interface SignedExternalRelease {
  readonly release: ExternalRelease;
  readonly signature: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly value: string;
  };
}

export type ExternalReleaseCheck =
  | { readonly valid: true; readonly release: ExternalRelease }
  | { readonly valid: false; readonly errors: readonly string[] };

export interface ExternalReleaseOptions {
  readonly publicKey: KeyObject;
  /** This endpoint's URL, exactly as it is registered in parmana-core. */
  readonly audience: string;
  /** The capabilities this endpoint serves. */
  readonly capabilities: readonly string[];
  readonly now: Date;
}

/** True when the body has the shape of a signed release. Says nothing about its validity. */
export function isSignedExternalRelease(body: unknown): body is SignedExternalRelease {
  return isObject(body) && isObject(body.release) && isObject(body.signature);
}

/**
 * Checks a signed release: shape, signature, audience, capability and expiry.
 * It records nothing. A release that passes is not yet claimed; see the release ledger.
 */
export async function checkExternalRelease(
  body: SignedExternalRelease,
  options: ExternalReleaseOptions,
): Promise<ExternalReleaseCheck> {
  const { release, signature } = body;
  const errors = shapeErrors(release);

  if (signature.algorithm !== "ed25519") {
    errors.push("signature.algorithm must be ed25519");
  }
  if (signature.keyId !== RELEASE_KEY_ID) {
    errors.push(`signature.keyId must be ${RELEASE_KEY_ID}`);
  }
  if (typeof signature.value !== "string") {
    errors.push("signature.value must be a string");
  } else if (!signatureVerifies(options.publicKey, signature.value, release)) {
    errors.push("the signature does not verify");
  }

  if (release.audience !== options.audience) {
    errors.push(`release.audience ${JSON.stringify(release.audience ?? null)} is not this endpoint`);
  }

  // The signed connector identity must be the one parmana-core derives from the capability.
  // A release signed for another capability, or for a bare vendor name, is refused.
  const identity = expectedConnectorId(release.capability ?? "");
  if (release.connectorId !== identity) {
    errors.push(`release.connectorId ${JSON.stringify(release.connectorId ?? null)} is not ${JSON.stringify(identity)}`);
  }

  if (!options.capabilities.includes(release.capability)) {
    errors.push(`release.capability ${JSON.stringify(release.capability ?? null)} is not served by this endpoint`);
  }

  // parmana-core signs business conditions into a release, and this service cannot verify them yet.
  // Acting on a release whose conditions it cannot check would ignore them, so the release is refused
  // before it is claimed. It is not recorded, so it can be sent again once the service can verify them.
  if (release.conditions !== undefined) {
    if (!Array.isArray(release.conditions)) {
      errors.push("release.conditions must be a list");
    } else if (release.conditions.length > 0) {
      errors.push(
        `the release carries ${release.conditions.length} business condition(s), which this service cannot verify; it refuses the release`,
      );
    }
  }

  const issuedAt = typeof release.issuedAt === "string" ? Date.parse(release.issuedAt) : Number.NaN;
  const expiresAt = typeof release.expiresAt === "string" ? Date.parse(release.expiresAt) : Number.NaN;
  if (Number.isNaN(issuedAt)) {
    errors.push("release.issuedAt is not a date");
  } else if (issuedAt > options.now.getTime() + CLOCK_SKEW_MS) {
    errors.push(`the release was issued in the future, at ${release.issuedAt}`);
  }
  if (Number.isNaN(expiresAt)) {
    errors.push("release.expiresAt is not a date");
  } else if (options.now.getTime() > expiresAt + CLOCK_SKEW_MS) {
    errors.push(`the release expired at ${release.expiresAt}`);
  }
  if (!Number.isNaN(issuedAt) && !Number.isNaN(expiresAt)) {
    const lifetime = expiresAt - issuedAt;
    if (lifetime <= 0) {
      errors.push("release.expiresAt must be after release.issuedAt");
    } else if (lifetime > MAX_RELEASE_LIFETIME_MS) {
      errors.push(`the release lifetime is ${lifetime / 1000} s; the limit is ${MAX_RELEASE_LIFETIME_MS / 1000} s`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, release };
}

function signatureVerifies(publicKey: KeyObject, value: string, release: ExternalRelease): boolean {
  try {
    const bytes = new CanonicalSerializer().serialize(release);
    const signature = Buffer.from(value, "base64");
    if (verify(null, bytes, publicKey, signature)) return true;
    // A commitment is accepted only above the limit, so it cannot stand in for a signature over a small message.
    if (bytes.length <= KMS_RAW_MESSAGE_LIMIT_BYTES) return false;
    const commitment = Buffer.concat([COMMITMENT_PREFIX, createHash("sha512").update(bytes).digest()]);
    return verify(null, commitment, publicKey, signature);
  } catch {
    return false;
  }
}

function shapeErrors(release: ExternalRelease): string[] {
  const errors: string[] = [];

  if (release.version !== 1) errors.push("release.version must be 1");
  for (const field of ["businessTransactionId", "capability", "target", "audience", "expiresAt"] as const) {
    if (typeof release[field] !== "string" || release[field].length === 0) {
      errors.push(`release.${field} must be a non-empty string`);
    }
  }
  if (!isObject(release.parameters)) {
    errors.push("release.parameters must be an object");
  }

  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
