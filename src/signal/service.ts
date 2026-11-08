import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  answerPaymentRefundable,
  SignalUnavailableError,
} from "./razorpay-payment-signal.js";
import {
  signAnswer,
  verifySignedQuery,
  type SignalAnswerMessage,
} from "./protocol.js";

/**
 * The Razorpay signal service: a business signal source for parmana-core. It answers only signed queries
 * from parmana-core, for its own audience, and never answers from the request. The read-only Razorpay key
 * stays in this service; parmana-core never holds it.
 */

export const SIGNAL_REQUEST_MAX_BYTES = 16 * 1024;
export const SIGNAL_SOURCE_NAME = "razorpay-payments";

export interface SignalServiceOptions {
  /** The exact URL parmana-core queries. Queries for any other audience are refused. */
  readonly audience: string;
  readonly source?: string;
  /** parmana-core's public key, which signs each query. */
  readonly parmanaPublicKeyPem: string;
  readonly parmanaKeyId?: string;
  /** This service's Ed25519 private key, which signs each answer. */
  readonly signingKeyPem: string;
  readonly signingKeyId: string;
  /** The read-only Razorpay key, "<key id>:<key secret>". */
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export function createSignalService(
  options: SignalServiceOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const source = options.source ?? SIGNAL_SOURCE_NAME;
  const parmanaKeyId = options.parmanaKeyId ?? "default";
  const now = options.now ?? (() => new Date());

  return (req, res) => {
    if (req.method !== "POST")
      return send(res, 405, { error: "method not allowed" });
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !type.startsWith("application/json")) {
      return send(res, 415, { error: "content-type must be application/json" });
    }
    readBody(req, SIGNAL_REQUEST_MAX_BYTES).then(
      async (raw) => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "the body is not JSON" });
        }
        const verified = verifySignedQuery(body, {
          parmanaPublicKeyPem: options.parmanaPublicKeyPem,
          parmanaKeyId,
          audience: options.audience,
          source,
          now: now(),
        });
        if (!verified.ok) return send(res, 403, { error: verified.reason });

        let answer: SignalAnswerMessage;
        try {
          answer = await answerPaymentRefundable(verified.query, {
            credential: options.credential,
            ...(options.fetch !== undefined && { fetch: options.fetch }),
            now,
          });
        } catch (error) {
          if (error instanceof SignalUnavailableError) {
            return send(res, 503, { error: error.message });
          }
          return send(res, 503, { error: "the payment could not be read" });
        }
        return send(
          res,
          200,
          signAnswer(answer, options.signingKeyPem, options.signingKeyId),
        );
      },
      () => {
        res.setHeader("connection", "close");
        send(res, 413, { error: "the request is too large" });
      },
    );
  };
}

export function createSignalHttpServer(options: SignalServiceOptions): Server {
  return createServer(createSignalService(options));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering, but do not destroy the socket: the client must receive the 413.
        reject(new Error("too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
