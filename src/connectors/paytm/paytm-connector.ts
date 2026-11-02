import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector-contract.js";

/**
 * A connector for Paytm refunds. It has the same shape as the generic
 * connector, so the execution service can run either one.
 *
 * It refunds one already-charged Paytm transaction, once, even when a release
 * is sent twice. Each refund carries a refId: the caller's refundReference when
 * one is given, otherwise Parmana's businessTransactionId. Before it sends a
 * refund, it asks Paytm for the refId's status. A confirmed refund is returned
 * instead of a new one, and a pending refund is refused, not sent again.
 *
 * Calls are signed the way Paytm's refund API expects: the request body, with
 * the merchant id added, is hashed with a random salt and encrypted with the
 * merchant key (AES-128-CBC). The merchant key never leaves this process except
 * inside that encrypted signature.
 *
 * The credential is one value, "<merchant id>:<merchant key>". The merchant key
 * must be exactly 16 bytes. Amounts are in rupees, with at most two decimals.
 *
 * The request and response shapes are taken from parmana-paytm-agent. They have
 * not been checked against a live Paytm account, which this repository cannot reach.
 */

export const PAYTM_REFUND_CAPABILITY = "paytm:refund";

export type PaytmEnvironment = "staging" | "production";

const BASE_URLS: Readonly<Record<PaytmEnvironment, string>> = {
  staging: "https://securestage.paytmpayments.com",
  production: "https://secure.paytmpayments.com",
};

/** The fixed IV that Paytm's checksum scheme uses. */
const CHECKSUM_IV = "@@@@&&&&####$$$$";
const CHECKSUM_SALT_LENGTH = 4;
const MERCHANT_KEY_BYTES = 16;

/** The only parameter names this connector forwards. Any other name is refused before any call. */
const ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(["orderId", "transactionId", "amount", "refundReason", "refundReference"]);
const REFUND_REASON_MAX_LENGTH = 256;
const REFUND_REFERENCE_MAX_LENGTH = 128;
/** The time limit when the caller gives none. The service always gives one. */
const DEFAULT_BUDGET_MS = 10_000;

/** Statuses Paytm reports for a refund that has completed. PENDING is deliberately not here. */
const CONFIRMED_SUCCESS: ReadonlySet<string> = new Set(["S", "SUCCESS", "TXN_SUCCESS"]);
const PENDING = "PENDING";

export interface PaytmConnectorOptions {
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Defaults to staging. Production is refused unless allowProduction is true. */
  readonly environment?: PaytmEnvironment;
  /** Production moves real money. Default false. */
  readonly allowProduction?: boolean;
}

export interface PaytmCredential {
  readonly merchantId: string;
  readonly merchantKey: string;
}

interface PaytmCall {
  readonly httpStatus: number;
  /** The `body` object of Paytm's response, which holds resultInfo. */
  readonly body: Record<string, unknown>;
}

interface PaytmOutcome {
  readonly status: string;
  readonly code: string | null;
  readonly message: string | null;
}

/**
 * Reads a credential value, "<merchant id>:<merchant key>". It never includes
 * the merchant key in an error message.
 */
export function parsePaytmCredential(value: string): PaytmCredential {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ConnectorError("credential_invalid", 'The Paytm credential must be "<merchant id>:<merchant key>".');
  }

  const merchantId = value.slice(0, separator).trim();
  const merchantKey = value.slice(separator + 1);
  if (merchantId === "") {
    throw new ConnectorError("credential_invalid", "The Paytm merchant id is empty.");
  }
  if (Buffer.byteLength(merchantKey, "utf8") !== MERCHANT_KEY_BYTES) {
    throw new ConnectorError("credential_invalid", "The Paytm merchant key must be exactly 16 bytes. Its value is not shown.");
  }

  return { merchantId, merchantKey };
}

/** Paytm's checksum: sha256(body|salt) followed by the salt, encrypted with AES-128-CBC. */
export function paytmChecksum(json: string, merchantKey: string, salt: string = randomSalt(CHECKSUM_SALT_LENGTH)): string {
  const hash = createHash("sha256").update(`${json}|${salt}`, "utf8").digest("hex") + salt;
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(merchantKey, "utf8"), Buffer.from(CHECKSUM_IV, "utf8"));
  return Buffer.concat([cipher.update(hash, "utf8"), cipher.final()]).toString("base64");
}

function randomSalt(length: number): string {
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64")
    .slice(0, length);
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads resultInfo.{resultStatus, resultCode, resultMsg} from a Paytm response body. */
function readOutcome(body: Record<string, unknown>): PaytmOutcome {
  const source = isRecord(body["resultInfo"]) ? body["resultInfo"] : body;
  return {
    status: (text(source["resultStatus"]) ?? "UNKNOWN").toUpperCase(),
    code: text(source["resultCode"]),
    message: text(source["resultMsg"]),
  };
}

function refuseParameters(message: string): never {
  throw new ConnectorError("invalid_input", message);
}

interface RefundInput {
  readonly orderId: string;
  readonly transactionId: string;
  readonly amount: string;
  readonly refundReason: string | undefined;
  readonly refId: string;
}

function readRefundInput(request: ConnectorRequest): RefundInput {
  const parameters = request.parameters;

  for (const name of Object.keys(parameters)) {
    if (!ALLOWED_PARAMETERS.has(name)) {
      refuseParameters(`Parameter "${name}" is not allowed for paytm:refund.`);
    }
  }

  const orderId = parameters["orderId"];
  if (typeof orderId !== "string" || orderId.trim() === "") {
    refuseParameters("orderId must be a non-empty string.");
  }

  const transactionId = parameters["transactionId"];
  if (typeof transactionId !== "string" || transactionId.trim() === "") {
    refuseParameters("transactionId must be a non-empty string.");
  }

  const amount = parameters["amount"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    refuseParameters("amount must be a positive number of rupees.");
  }
  if (Number(amount.toFixed(2)) !== amount) {
    refuseParameters("amount must have at most two decimal places.");
  }

  const refundReason = parameters["refundReason"];
  let reason: string | undefined;
  if (refundReason !== undefined) {
    if (typeof refundReason !== "string" || refundReason.length > REFUND_REASON_MAX_LENGTH) {
      refuseParameters(`refundReason must be a string of at most ${REFUND_REASON_MAX_LENGTH} characters.`);
    }
    reason = refundReason.trim() === "" ? undefined : refundReason.trim();
  }

  const refundReference = parameters["refundReference"];
  let reference: string | undefined;
  if (refundReference !== undefined) {
    if (typeof refundReference !== "string" || refundReference.trim() === "" || refundReference.length > REFUND_REFERENCE_MAX_LENGTH) {
      refuseParameters(`refundReference must be a non-empty string of at most ${REFUND_REFERENCE_MAX_LENGTH} characters.`);
    }
    reference = refundReference.trim();
  }

  // The release's businessTransactionId is the receipt that makes the refund act-once.
  const refId = reference ?? request.businessTransactionId;
  if (refId === undefined || refId.trim() === "") {
    refuseParameters("A refund needs a refundReference or a businessTransactionId.");
  }

  return {
    orderId: orderId.trim(),
    transactionId: transactionId.trim(),
    amount: amount.toFixed(2),
    refundReason: reason,
    refId: refId.trim(),
  };
}

export function createPaytmConnector(options: PaytmConnectorOptions = {}): GenericConnector {
  const environment: PaytmEnvironment = options.environment ?? "staging";
  if (environment === "production" && options.allowProduction !== true) {
    throw new Error("Production Paytm is refused unless allowProduction is true.");
  }
  const baseUrl = BASE_URLS[environment];
  const doFetch = options.fetch ?? fetch;

  async function call(path: string, body: Record<string, unknown>, credential: PaytmCredential, signal: AbortSignal): Promise<PaytmCall> {
    const signedBody: Record<string, unknown> = { ...body, mid: credential.merchantId };
    const signature = paytmChecksum(JSON.stringify(signedBody), credential.merchantKey);
    const response = await doFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ body: signedBody, head: { tokenType: "AES", signature, channelId: "WEB" } }),
      signal,
    });

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConnectorError("upstream_error", `Paytm returned a response that is not JSON (HTTP ${response.status}).`);
    }
    if (!isRecord(parsed)) {
      throw new ConnectorError("upstream_error", `Paytm returned an unexpected response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const outcome = readOutcome(isRecord(parsed["body"]) ? parsed["body"] : parsed);
      throw new ConnectorError("upstream_error", `Paytm returned HTTP ${response.status} (status ${outcome.status}${outcome.code ? `, code ${outcome.code}` : ""}).`);
    }

    return { httpStatus: response.status, body: isRecord(parsed["body"]) ? parsed["body"] : parsed };
  }

  return {
    system: "paytm",
    capabilities: [PAYTM_REFUND_CAPABILITY],

    async execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse> {
      if (request.capability !== PAYTM_REFUND_CAPABILITY) {
        throw new ConnectorError("unknown_capability", `The Paytm connector does not run "${request.capability}".`);
      }

      const input = readRefundInput(request);
      const credential = parsePaytmCredential(context.credential.value);

      const budget = context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_BUDGET_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);

      try {
        // 1. Ask Paytm whether this refId already has a refund. Read-only, so a timeout here changes nothing.
        let existing: PaytmOutcome;
        try {
          existing = readOutcome((await call("/v2/refund/status", { orderId: input.orderId, refId: input.refId }, credential, controller.signal)).body);
        } catch (error) {
          if (error instanceof ConnectorError) throw error;
          throw new ConnectorError("timeout", "Paytm did not answer the refund status check in time. No refund was sent.");
        }

        if (CONFIRMED_SUCCESS.has(existing.status)) {
          return {
            success: true,
            metadata: { status: 200, body: { refId: input.refId, reused: true, paytmStatus: existing.status } },
          };
        }
        if (existing.status === PENDING) {
          throw new ConnectorError("upstream_error", "Paytm reports this refund as PENDING. It was not sent again. Check Paytm before any other action.");
        }

        // 2. Send the refund. From here on a failure may mean the refund reached Paytm, so the message says to check.
        let applied: PaytmCall;
        try {
          applied = await call(
            "/refund/apply",
            {
              txnType: "REFUND",
              orderId: input.orderId,
              txnId: input.transactionId,
              refId: input.refId,
              refundAmount: input.amount,
              ...(input.refundReason !== undefined ? { comments: input.refundReason } : {}),
            },
            credential,
            controller.signal,
          );
        } catch (error) {
          if (error instanceof ConnectorError) throw error;
          throw new ConnectorError("upstream_error", "The refund request may have reached Paytm, and no answer was read. Check Paytm for this refId before any other action.");
        }

        const outcome = readOutcome(applied.body);
        if (CONFIRMED_SUCCESS.has(outcome.status)) {
          return {
            success: true,
            metadata: { status: applied.httpStatus, body: { refId: input.refId, reused: false, paytmStatus: outcome.status } },
          };
        }
        if (outcome.status === PENDING) {
          throw new ConnectorError("upstream_error", "Paytm accepted the refund as PENDING. Check Paytm before any other action.");
        }
        throw new ConnectorError("upstream_error", `Paytm did not confirm the refund (status ${outcome.status}${outcome.code ? `, code ${outcome.code}` : ""}).`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
