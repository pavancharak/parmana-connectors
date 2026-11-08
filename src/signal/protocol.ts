import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { CanonicalSerializer } from "@parmana/crypto";

/**
 * The wire protocol between parmana-core and a business signal source (RFC-0023 phase 2), as
 * parmana-core's HttpBusinessSignalSource speaks it. Core signs each query with its own Ed25519 key over
 * the canonical JSON of the query; the source checks that signature, the audience and the expiry, and
 * answers with an envelope it signs over the canonical JSON of the answer.
 */

export const SIGNAL_QUERY_MAX_LIFETIME_MS = 60_000;
export const SIGNAL_CLOCK_SKEW_MS = 30_000;

export interface SignalQueryMessage {
  readonly version: 1;
  readonly source: string;
  readonly audience: string;
  readonly signalKey: string;
  readonly claim: string;
  readonly subject: string;
  readonly action: string;
  readonly businessTransactionId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** The intent parameters this source needs for the claim, as Core discloses them. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface SignedSignalQuery {
  readonly query: SignalQueryMessage;
  readonly signature: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly value: string;
  };
}

export type SignalAnswerMessage =
  | {
      readonly version: 1;
      readonly source: string;
      readonly nonce: string;
      readonly signalKey: string;
      readonly claim: string;
      readonly subject: string;
      readonly status: "observed";
      readonly value: boolean;
      readonly observedAt: string;
      readonly validUntil: string;
    }
  | {
      readonly version: 1;
      readonly source: string;
      readonly nonce: string;
      readonly signalKey: string;
      readonly claim: string;
      readonly subject: string;
      readonly status: "not_found" | "conflicting";
      readonly reason: string;
    };

export interface SignedSignalAnswer {
  readonly answer: SignalAnswerMessage;
  readonly signature: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export type VerifiedQuery =
  | { readonly ok: true; readonly query: SignalQueryMessage }
  | { readonly ok: false; readonly reason: string };

const serializer = new CanonicalSerializer();

/** Checks a signed query from parmana-core: its signature, audience, source, and freshness. */
export function verifySignedQuery(
  body: unknown,
  options: {
    readonly parmanaPublicKeyPem: string;
    readonly parmanaKeyId: string;
    readonly audience: string;
    readonly source: string;
    readonly now: Date;
  },
): VerifiedQuery {
  if (typeof body !== "object" || body === null)
    return { ok: false, reason: "the body is not an object" };
  const { query, signature } = body as Partial<SignedSignalQuery>;
  if (typeof query !== "object" || query === null)
    return { ok: false, reason: "the body has no query" };
  if (typeof signature !== "object" || signature === null)
    return { ok: false, reason: "the query is not signed" };
  if (
    signature.algorithm !== "ed25519" ||
    signature.keyId !== options.parmanaKeyId ||
    typeof signature.value !== "string"
  ) {
    return {
      ok: false,
      reason: "the query is not signed by parmana-core's registered key",
    };
  }

  const publicKey: KeyObject = createPublicKey(options.parmanaPublicKeyPem);
  const valid = verify(
    null,
    Buffer.from(serializer.serialize(query)),
    publicKey,
    Buffer.from(signature.value, "base64"),
  );
  if (!valid)
    return { ok: false, reason: "the query's signature does not verify" };

  const message = query as SignalQueryMessage;
  if (message.version !== 1)
    return { ok: false, reason: "the query is not version 1" };
  if (message.audience !== options.audience)
    return { ok: false, reason: "the query is addressed to another source" };
  if (message.source !== options.source)
    return {
      ok: false,
      reason: `the query names source "${message.source}", not "${options.source}"`,
    };
  if (typeof message.nonce !== "string" || message.nonce.length === 0)
    return { ok: false, reason: "the query has no nonce" };

  const issuedAt = Date.parse(message.issuedAt);
  const expiresAt = Date.parse(message.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt))
    return { ok: false, reason: "the query's times are not dates" };
  if (expiresAt - issuedAt > SIGNAL_QUERY_MAX_LIFETIME_MS)
    return { ok: false, reason: "the query lives longer than 60 seconds" };
  if (options.now.getTime() > expiresAt)
    return { ok: false, reason: "the query has expired" };
  if (issuedAt > options.now.getTime() + SIGNAL_CLOCK_SKEW_MS)
    return { ok: false, reason: "the query was issued in the future" };

  return { ok: true, query: message };
}

/** Signs an answer with the source's own Ed25519 key, over the canonical JSON of the answer. */
export function signAnswer(
  answer: SignalAnswerMessage,
  privateKeyPem: string,
  keyId: string,
): SignedSignalAnswer {
  const key = createPrivateKey(privateKeyPem);
  const value = sign(
    null,
    Buffer.from(serializer.serialize(answer)),
    key,
  ).toString("base64");
  return { answer, signature: { algorithm: "ed25519", keyId, value } };
}
