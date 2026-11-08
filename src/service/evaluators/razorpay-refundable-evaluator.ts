import { ConnectorError } from "../../connector-contract.js";
import { assertRazorpayCredential } from "../../connectors/razorpay/razorpay-connector.js";
import type { ConditionEvaluator, ConditionVerdict, ReleaseCondition } from "../condition-evaluator.js";
import type { ExternalRelease } from "../release.js";

/**
 * Checks that a Razorpay payment is still refundable for the requested amount, immediately before the
 * refund is made. It reads the payment's current state from Razorpay; it does not trust the release.
 *
 * Holds when the payment is captured and the unrefunded amount covers the request. Anything else is a
 * condition that does not hold. A payment that cannot be read, or a response without the fields the
 * check needs, is a failure to verify: the evaluator throws, and the service does not call the connector.
 *
 * atomicity is "check-then-act". Razorpay's refund call cannot be made conditional on the payment state,
 * so a change between this read and the refund is not caught. That window is stated in the answer.
 */

export const RAZORPAY_REFUNDABLE_SIGNAL_KEY = "payment.refundable";

const API = "https://api.razorpay.com/v1";
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const READ_TIMEOUT_MS = 10_000;

export interface RazorpayRefundableOptions {
  /** The credential the connector uses, "<key id>:<key secret>". Read at startup, never logged. */
  readonly credential: string;
  readonly allowLiveKeys?: boolean;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Injectable for tests. */
  readonly now?: () => Date;
}

interface PaymentState {
  readonly status: string;
  readonly amount: number;
  readonly amountRefunded: number;
  readonly refundStatus: string | null;
}

export function createRazorpayRefundableEvaluator(options: RazorpayRefundableOptions): ConditionEvaluator {
  assertRazorpayCredential(options.credential, options.allowLiveKeys ?? false);
  const authorization = `Basic ${Buffer.from(options.credential).toString("base64")}`;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  async function readPayment(paymentId: string): Promise<PaymentState> {
    const response = await doFetch(`${API}/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: authorization },
      redirect: "error",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new ConnectorError("upstream_error", `Razorpay answered HTTP ${response.status} for the payment read`);
    }
    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ConnectorError("upstream_error", "Razorpay's payment read was not JSON");
    }
    if (typeof json.status !== "string" || typeof json.amount !== "number" || typeof json.amount_refunded !== "number") {
      throw new ConnectorError("upstream_error", "Razorpay's payment read is missing status, amount or amount_refunded");
    }
    return {
      status: json.status,
      amount: json.amount,
      amountRefunded: json.amount_refunded,
      refundStatus: typeof json.refund_status === "string" ? json.refund_status : null,
    };
  }

  return {
    signalKey: RAZORPAY_REFUNDABLE_SIGNAL_KEY,
    atomicity: "check-then-act",
    async evaluate(condition: ReleaseCondition, release: ExternalRelease): Promise<ConditionVerdict> {
      const paymentId = release.target;
      if (!PAYMENT_ID.test(paymentId) || condition.subject !== paymentId) {
        // The condition is about a different object than the one the release acts on: it cannot be checked
        // against this refund, so it is a failure to verify, not a condition that does not hold.
        throw new ConnectorError("invalid_input", "the condition's subject is not the release's payment");
      }
      const requested = release.parameters.amount;
      if (typeof requested !== "number" || !Number.isInteger(requested) || requested <= 0) {
        throw new ConnectorError("invalid_input", "parameters.amount must be a positive whole number of paise");
      }

      const payment = await readPayment(paymentId);
      const remaining = payment.amount - payment.amountRefunded;
      const evidence = {
        source: "razorpay",
        subject: paymentId,
        status: payment.status,
        amount: payment.amount,
        amountRefunded: payment.amountRefunded,
        refundStatus: payment.refundStatus,
        requested,
        observedAt: now().toISOString(),
      };

      if (payment.status !== "captured") {
        return { holds: false, reason: `the payment status is "${payment.status}", not "captured"`, evidence };
      }
      if (payment.refundStatus === "full" || remaining < requested) {
        return {
          holds: false,
          reason: `${remaining} paise remain refundable, ${requested} paise requested`,
          evidence,
        };
      }
      return { holds: true, evidence };
    },
  };
}
