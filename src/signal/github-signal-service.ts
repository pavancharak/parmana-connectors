import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { answerGitHubSignal, SignalUnavailableError, type GitHubSignalOptions } from "./github-signal.js";
import { signAnswer, verifySignedQuery, type SignalAnswerMessage } from "./protocol.js";

/**
 * The GitHub signal service: a business signal source for Parmana. It answers only signed queries from
 * Parmana for its own audience. The GitHub App key stays in this service. Parmana never holds it.
 * Same wire protocol and checks as the Razorpay signal service.
 */

export const GITHUB_SIGNAL_SOURCE_NAME = "github-pull-requests";
export const SIGNAL_REQUEST_MAX_BYTES = 16 * 1024;

export interface GitHubSignalServiceOptions extends Omit<GitHubSignalOptions, "now"> {
  /** The exact URL Parmana queries. Queries for any other audience are refused. */
  readonly audience: string;
  readonly source?: string;
  readonly parmanaPublicKeyPem: string;
  readonly parmanaKeyId?: string;
  /** This service's Ed25519 private key, which signs each answer. */
  readonly signingKeyPem: string;
  readonly signingKeyId: string;
  readonly now?: () => Date;
}

export function createGitHubSignalService(
  options: GitHubSignalServiceOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const source = options.source ?? GITHUB_SIGNAL_SOURCE_NAME;
  const parmanaKeyId = options.parmanaKeyId ?? "default";
  const now = options.now ?? (() => new Date());

  return (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
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
        if (!verified.ok) {
          console.warn({ event: "signal_query_refused", reason: verified.reason });
          return send(res, 403, { error: verified.reason });
        }

        let answer: SignalAnswerMessage;
        try {
          answer = await answerGitHubSignal(verified.query, {
            credential: options.credential,
            allowedRepositories: options.allowedRepositories,
            ...(options.fetch !== undefined && { fetch: options.fetch }),
            ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
            now,
          });
        } catch (error) {
          if (error instanceof SignalUnavailableError) return send(res, 503, { error: error.message });
          return send(res, 503, { error: "the GitHub record could not be read" });
        }
        return send(res, 200, signAnswer(answer, options.signingKeyPem, options.signingKeyId));
      },
      () => {
        res.setHeader("connection", "close");
        send(res, 413, { error: "the request is too large" });
      },
    );
  };
}

export function createGitHubSignalHttpServer(options: GitHubSignalServiceOptions): Server {
  return createServer(createGitHubSignalService(options));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
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
