import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector-contract.js";

/**
 * A connector for Razorpay refunds. It has the same shape as the generic
 * connector, so the execution service can run either one.
 *
 * It refunds a payment once, even when a release is sent twice. Each refund
 * carries Parmana's businessTransactionId as its Razorpay `receipt`. Before it
 * creates one, it lists the payment's refunds, and an existing refund with
 * that receipt is returned instead of a new refund.
 *
 * The credential is one value, "<key id>:<key secret>", read from the
 * environment by the caller. Live keys (rzp_live_) are refused unless the
 * caller allows them. Amounts are in paise.
 */

export const RAZORPAY_REFUND_CAPABILITY = "razorpay:refund";

const API = "https://api.razorpay.com/v1";
/** The time limit when the caller gives none. The service always gives one. */
const DEFAULT_BUDGET_MS = 10_000;
/** Refunds read per page when looking for an earlier refund. */
const REFUND_PAGE_SIZE = 100;
/** Pages read before refusing. 1,000 refunds on one payment is far beyond normal use. */
const MAX_REFUND_PAGES = 10;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]+$/;

export interface RazorpayConnectorOptions {
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Live keys are refused unless this is true. Default false. */
  readonly allowLiveKeys?: boolean;
}

interface RazorpayRefund {
  readonly id: string;
  readonly amount: number;
  readonly status: string;
  readonly payment_id: string;
  readonly receipt?: string | null;
}

interface RazorpayCall {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

/** What the connector was doing when a call failed. Decides what the operator must check. */
type Stage = "listing the payment's refunds" | "creating the refund";

interface CallContext {
  readonly authorization: string;
  /** Epoch milliseconds. Every call must finish before this. */
  readonly deadline: number;
  readonly receipt: string;
}

export function createRazorpayConnector(options: RazorpayConnectorOptions = {}): GenericConnector {
  const doFetch = options.fetch ?? fetch;
  const allowLiveKeys = options.allowLiveKeys ?? false;

  /**
   * One call to Razorpay, limited by what is left of the overall time limit.
   * A GET never creates a refund. A POST may have, if it was sent and no answer came back.
   */
  async function call(stage: Stage, method: "GET" | "POST", path: string, ctx: CallContext, body?: unknown): Promise<RazorpayCall> {
    const remaining = ctx.deadline - Date.now();
    if (remaining <= 0) {
      throw noAnswer("timeout", stage, method, false, ctx.receipt);
    }

    let response: Response;
    try {
      response = await doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: ctx.authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        // The credential must never reach another host.
        redirect: "error",
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw noAnswer(timedOut ? "timeout" : "upstream_error", stage, method, true, ctx.receipt);
    }

    const text = await response.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: response.status, json };
  }

  return {
    system: "razorpay",
    capabilities: Object.freeze([RAZORPAY_REFUND_CAPABILITY]),

    async execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse> {
      if (request.capability !== RAZORPAY_REFUND_CAPABILITY) {
        throw new ConnectorError("unknown_capability", `capability "${request.capability}" is not a Razorpay capability`);
      }

      const authorization = basicAuthorization(context.credential.value, allowLiveKeys);
      const paymentId = request.target ?? "";
      if (!PAYMENT_ID.test(paymentId)) {
        throw new ConnectorError("invalid_input", "the target is not a Razorpay payment id (pay_...)");
      }
      const amount = request.parameters.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
        throw new ConnectorError("invalid_input", "parameters.amount must be a positive whole number of paise");
      }
      const receipt = request.businessTransactionId ?? "";
      if (receipt === "") {
        throw new ConnectorError("invalid_input", "the release has no businessTransactionId to use as the receipt");
      }

      const budget = context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_BUDGET_MS;
      const ctx: CallContext = { authorization, deadline: Date.now() + budget, receipt };

      for (let page = 0; ; page++) {
        if (page === MAX_REFUND_PAGES) {
          throw new ConnectorError(
            "upstream_error",
            `the payment has more than ${MAX_REFUND_PAGES * REFUND_PAGE_SIZE} refunds, so an earlier refund for receipt ${receipt} cannot be ruled out. No refund was created; check Razorpay`,
          );
        }
        const listed = await call(
          "listing the payment's refunds",
          "GET",
          `/payments/${paymentId}/refunds?count=${REFUND_PAGE_SIZE}&skip=${page * REFUND_PAGE_SIZE}`,
          ctx,
        );
        if (listed.status !== 200) {
          throw refusal("listing the payment's refunds", listed);
        }
        // A list that is not a list must not be read as "no earlier refund": that could refund twice.
        if (!Array.isArray(listed.json.items)) {
          throw new ConnectorError("upstream_error", "Razorpay's refund list had no items. No refund was created; check Razorpay");
        }
        const items = listed.json.items as RazorpayRefund[];
        const earlier = items.find((item) => item.receipt === receipt);
        if (earlier !== undefined) {
          // A failed refund did not return the money. Reporting it as done would hide the failure.
          if (earlier.status === "failed") {
            throw new ConnectorError(
              "upstream_error",
              `Razorpay has a failed refund (${earlier.id}) for receipt ${receipt}. No refund was created; check Razorpay before any other action`,
            );
          }
          return answer(earlier, true);
        }
        if (items.length < REFUND_PAGE_SIZE) {
          break;
        }
      }

      const created = await call("creating the refund", "POST", `/payments/${paymentId}/refund`, ctx, {
        amount,
        speed: "normal",
        receipt,
        notes: { parmanaBusinessTransactionId: receipt },
      });
      if (created.status !== 200) {
        throw refusal("creating the refund", created);
      }
      // A 200 without a refund id is not an answer. The refund may exist, so say so.
      if (typeof created.json.id !== "string") {
        throw new ConnectorError(
          "upstream_error",
          `Razorpay answered the refund creation without a refund id. A refund may have been created: check Razorpay for a refund with receipt ${receipt} before any other action`,
        );
      }
      return answer(created.json as unknown as RazorpayRefund, false);
    },
  };
}

/**
 * Checks that a credential can be used, without ever naming its value in the
 * error. Used at startup by the service, and on every call by the connector.
 */
export function assertRazorpayCredential(value: string, allowLiveKeys: boolean): void {
  const separator = value.indexOf(":");
  const keyId = separator < 0 ? "" : value.slice(0, separator);
  const keySecret = separator < 0 ? "" : value.slice(separator + 1);
  if (!KEY_ID.test(keyId) || keySecret.trim() === "") {
    throw new ConnectorError("credential_invalid", "the Razorpay credential must be \"<key id>:<key secret>\" with a rzp_test_ or rzp_live_ key id");
  }
  if (keyId.startsWith("rzp_live_") && !allowLiveKeys) {
    throw new ConnectorError("credential_invalid", "live Razorpay keys are refused unless live keys are allowed for this service");
  }
}

/** The Basic authorization header for a credential that has passed assertRazorpayCredential. */
function basicAuthorization(value: string, allowLiveKeys: boolean): string {
  assertRazorpayCredential(value, allowLiveKeys);
  return `Basic ${Buffer.from(value).toString("base64")}`;
}

function answer(refund: RazorpayRefund, alreadyRefunded: boolean): ConnectorResponse {
  return {
    success: true,
    metadata: {
      status: 200,
      body: {
        refundId: refund.id,
        paymentId: refund.payment_id,
        amount: refund.amount,
        status: refund.status,
        receipt: refund.receipt ?? null,
        alreadyRefunded,
      },
    },
  };
}

/**
 * A call that got no usable answer. A failed POST may have created the refund,
 * so the message tells the operator to check Razorpay for the receipt. A failed
 * GET, or a POST never sent, created nothing.
 */
function noAnswer(code: "timeout" | "upstream_error", stage: Stage, method: "GET" | "POST", sent: boolean, receipt: string): ConnectorError {
  const reason = code === "timeout" ? "did not answer in time" : "could not be reached";
  if (method === "POST" && sent) {
    return new ConnectorError(code, `Razorpay ${reason} while ${stage}. A refund may have been created: check Razorpay for a refund with receipt ${receipt} before any other action`);
  }
  return new ConnectorError(code, `Razorpay ${reason} while ${stage}. No refund was created`);
}

/** Razorpay's own error code and description, when it gave them. Never the credential. */
function refusal(stage: Stage, failed: RazorpayCall): ConnectorError {
  const error = (failed.json.error ?? {}) as { code?: unknown; description?: unknown };
  const code = typeof error.code === "string" ? error.code : "none";
  const description = typeof error.description === "string" ? error.description.slice(0, 200) : "no description";
  return new ConnectorError("upstream_error", `Razorpay refused ${stage} (HTTP ${failed.status}, code ${code}: ${description})`);
}
