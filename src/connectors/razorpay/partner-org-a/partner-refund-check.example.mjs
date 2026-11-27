// Example for the partner's system (org A): ask Parmana before a Razorpay refund.
//
// This is an example to adapt, not production code. It does not perform the refund.
// Run it with Node 24 and the environment variables listed at the bottom of this file.
//
// Flow:
//   1. Ask Parmana for a decision on the refund (POST /v1/inbound/checks).
//   2. Refuse unless the decision is "approved", its signature verifies, and it has not expired.
//   3. Only then perform the refund, through Parmana's Razorpay connector (not directly).

import { createPublicKey, verify } from "node:crypto";

const PARMANA_URL = process.env.PARMANA_URL; // e.g. https://parmana.example
const PARTNER_TOKEN = process.env.PARMANA_PARTNER_TOKEN; // partner's own credential, not a Razorpay key
const AUDIENCE = process.env.PARMANA_AUDIENCE; // the audience Parmana registered for this partner
const PARMANA_PUBLIC_KEY_PEM = process.env.PARMANA_PUBLIC_KEY_PEM; // Parmana's published Ed25519 gateway public key
const PARMANA_SECONDARY_PUBLIC_KEY_PEM = process.env.PARMANA_SECONDARY_PUBLIC_KEY_PEM; // Parmana's ML-DSA-65 public key
const TIMEOUT_MS = Number(process.env.PARMANA_TIMEOUT_MS ?? 5000);

// Canonical bytes, matching canonicalCheckBytes in packages/api/src/routes/inbound-checks.ts:
// every field except the two signatures, keys sorted at the top level, compact JSON.
// Both signatures cover these same bytes.
export function canonicalBytes(decision) {
  const { signature: _ignored, secondarySignature: _ignoredSecondary, ...fields } = decision;
  const sorted = Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]]),
  );
  return Buffer.from(JSON.stringify(sorted));
}

// Ask Parmana. Any error, timeout or unexpected status is treated as "not approved".
export async function askParmana({ capability, target, amount }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${PARMANA_URL}/v1/inbound/checks`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PARTNER_TOKEN}`,
      },
      body: JSON.stringify({
        capability, // for example "payments:refund"
        audience: AUDIENCE,
        target, // the Razorpay payment id, for example pay_XXXX
        parameters: { amount }, // amount in paise (100 = Rs 1); the grant limit path "parameters.amount" must match
      }),
    });
    if (response.status !== 201) {
      return { approved: false, reason: `parmana_status_${response.status}` };
    }
    return { approved: true, decision: await response.json() };
  } catch {
    return { approved: false, reason: "parmana_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// Redeem an approved decision once, before acting on it. A second redemption is refused.
export async function redeemDecision(decisionId) {
  const response = await fetch(`${PARMANA_URL}/v1/inbound/checks/${decisionId}/redeem`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${PARTNER_TOKEN}` },
  });
  return response.status === 200;
}

// Decide whether to act on a decision. Returns { ok, reason }.
export function checkDecision(decision, now = new Date()) {
  if (decision.outcome !== "approved") {
    return { ok: false, reason: decision.reason ?? "not_approved" };
  }
  if (!decision.signature) {
    return { ok: false, reason: "missing_signature" };
  }
  if (!decision.secondarySignature) {
    return { ok: false, reason: "missing_secondary_signature" };
  }
  const bytes = canonicalBytes(decision);
  // Ed25519 (gateway key) and ML-DSA-65 (secondary key). Both must verify.
  const ed25519Ok = verify(
    null,
    bytes,
    createPublicKey(PARMANA_PUBLIC_KEY_PEM),
    Buffer.from(decision.signature, "base64"),
  );
  const mlDsaOk = verify(
    null,
    bytes,
    createPublicKey(PARMANA_SECONDARY_PUBLIC_KEY_PEM),
    Buffer.from(decision.secondarySignature, "base64"),
  );
  if (!ed25519Ok || !mlDsaOk) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!(new Date(decision.expiresAt) > now)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

// Example use. The refund step is a placeholder: it must call Parmana's Razorpay connector,
// because the partner must not hold a Razorpay key of their own.
export async function refundIfApproved({ paymentId, amount }) {
  const answer = await askParmana({
    capability: "payments:refund",
    target: paymentId,
    amount,
  });
  if (!answer.approved) return { refunded: false, reason: answer.reason };

  const check = checkDecision(answer.decision);
  if (!check.ok) return { refunded: false, reason: check.reason };

  // Redeem first: a decision covers one action only.
  if (!(await redeemDecision(answer.decision.decisionId))) {
    return { refunded: false, reason: "not_redeemed" };
  }

  // PLACEHOLDER: hand the approved decision to Parmana's connector path.
  // Do not call Razorpay directly from here.
  return { refunded: false, reason: "refund_step_not_wired", decisionId: answer.decision.decisionId };
}

// Environment variables:
//   PARMANA_URL, PARMANA_PARTNER_TOKEN, PARMANA_AUDIENCE,
//   PARMANA_PUBLIC_KEY_PEM (gateway key, Ed25519), PARMANA_SECONDARY_PUBLIC_KEY_PEM (ML-DSA-65),
//   PARMANA_TIMEOUT_MS (optional)
