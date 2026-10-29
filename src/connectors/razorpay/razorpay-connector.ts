import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector.js";

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
/** Two calls must fit inside the connector timeout that Parmana registers (10 s). */
const CALL_TIMEOUT_MS = 4_000;
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

export function createRazorpayConnector(options: RazorpayConnectorOptions = {}): GenericConnector {
  const doFetch = options.fetch ?? fetch;
  const allowLiveKeys = options.allowLiveKeys ?? false;

  async function call(method: "GET" | "POST", path: string, authorization: string, body?: unknown): Promise<RazorpayCall> {
    let response: Response;
    try {
      response = await doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        // The credential must never reach another host.
        redirect: "error",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new ConnectorError("timeout", "Razorpay did not answer in time. The refund may or may not have been created; resend the same release.");
      }
      throw new ConnectorError("upstream_error", "Razorpay could not be reached. The refund may or may not have been created; resend the same release.");
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

      const existing = await call("GET", `/payments/${paymentId}/refunds?count=100`, authorization);
      if (existing.status !== 200) {
        throw refusal("listing the payment's refunds", existing);
      }
      const items = (existing.json.items ?? []) as RazorpayRefund[];
      const earlier = items.find((item) => item.receipt === receipt);
      if (earlier !== undefined) {
        return answer(earlier, true);
      }

      const created = await call("POST", `/payments/${paymentId}/refund`, authorization, {
        amount,
        speed: "normal",
        receipt,
        notes: { parmanaBusinessTransactionId: receipt },
      });
      if (created.status !== 200) {
        throw refusal("creating the refund", created);
      }
      return answer(created.json as unknown as RazorpayRefund, false);
    },
  };
}

/** Splits "<key id>:<key secret>" and returns the Basic authorization header. Nothing it throws contains the value. */
function basicAuthorization(value: string, allowLiveKeys: boolean): string {
  const separator = value.indexOf(":");
  const keyId = separator < 0 ? "" : value.slice(0, separator);
  const keySecret = separator < 0 ? "" : value.slice(separator + 1);
  if (!KEY_ID.test(keyId) || keySecret.trim() === "") {
    throw new ConnectorError("credential_invalid", "the Razorpay credential must be \"<key id>:<key secret>\" with a rzp_test_ or rzp_live_ key id");
  }
  if (keyId.startsWith("rzp_live_") && !allowLiveKeys) {
    throw new ConnectorError("credential_invalid", "live Razorpay keys are refused: set PARMANA_RAZORPAY_ALLOW_LIVE_KEYS=true to allow them");
  }
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
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

/** Razorpay's own error code and description, when it gave them. Never the credential. */
function refusal(stage: string, failed: RazorpayCall): ConnectorError {
  const error = (failed.json.error ?? {}) as { code?: unknown; description?: unknown };
  const code = typeof error.code === "string" ? error.code : "none";
  const description = typeof error.description === "string" ? error.description.slice(0, 200) : "no description";
  return new ConnectorError("upstream_error", `Razorpay refused ${stage} (HTTP ${failed.status}, code ${code}: ${description})`);
}
