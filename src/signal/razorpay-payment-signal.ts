import type { SignalAnswerMessage, SignalQueryMessage } from "./protocol.js";

/**
 * Answers "payment.refundable" for a Razorpay payment, from Razorpay's own record. Holds only when the
 * payment is captured, not fully refunded, and has at least the requested amount left. The answer is
 * observed and valid for 60 seconds, the release lifetime.
 *
 * A payment Razorpay does not have is not_found. A read that fails throws, and the caller answers
 * unavailable. The credential never appears in an error or an answer.
 */

export const PAYMENT_REFUNDABLE_CLAIM = "payment.refundable";
const API = "https://api.razorpay.com/v1";
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const VALID_FOR_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;

export interface RazorpayPaymentSignalOptions {
  /** The read-only key, "<key id>:<key secret>". */
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export class SignalUnavailableError extends Error {}

export async function answerPaymentRefundable(
  query: SignalQueryMessage,
  options: RazorpayPaymentSignalOptions,
): Promise<SignalAnswerMessage> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const base = {
    version: 1 as const,
    source: query.source,
    nonce: query.nonce,
    signalKey: query.signalKey,
    claim: query.claim,
    subject: query.subject,
  };

  if (
    query.claim !== PAYMENT_REFUNDABLE_CLAIM ||
    query.signalKey !== PAYMENT_REFUNDABLE_CLAIM
  ) {
    return {
      ...base,
      status: "not_found",
      reason: `this source does not establish "${query.claim}"`,
    };
  }
  if (!PAYMENT_ID.test(query.subject)) {
    return {
      ...base,
      status: "not_found",
      reason: "the subject is not a Razorpay payment id",
    };
  }
  const requested = query.parameters?.amount;
  if (
    typeof requested !== "number" ||
    !Number.isInteger(requested) ||
    requested <= 0
  ) {
    return {
      ...base,
      status: "not_found",
      reason:
        "the query does not carry a positive whole refund amount in paise",
    };
  }

  const authorization = `Basic ${Buffer.from(options.credential).toString("base64")}`;
  const response = await doFetch(`${API}/payments/${query.subject}`, {
    method: "GET",
    headers: { Authorization: authorization },
    redirect: "error",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return {
      ...base,
      status: "not_found",
      reason: "Razorpay has no payment with this id",
    };
  }
  if (response.status !== 200) {
    throw new SignalUnavailableError(
      `Razorpay answered HTTP ${response.status} for the payment read`,
    );
  }

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new SignalUnavailableError("Razorpay's payment read was not JSON");
  }
  if (
    typeof json.status !== "string" ||
    typeof json.amount !== "number" ||
    typeof json.amount_refunded !== "number"
  ) {
    throw new SignalUnavailableError(
      "Razorpay's payment read is missing status, amount or amount_refunded",
    );
  }

  const refundStatus =
    typeof json.refund_status === "string" ? json.refund_status : null;
  const remaining = json.amount - json.amount_refunded;
  const holds =
    json.status === "captured" &&
    refundStatus !== "full" &&
    remaining >= requested;

  const observedAt = now();
  return {
    ...base,
    status: "observed",
    value: holds,
    observedAt: observedAt.toISOString(),
    validUntil: new Date(observedAt.getTime() + VALID_FOR_MS).toISOString(),
  };
}
