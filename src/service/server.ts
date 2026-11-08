import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { KeyObject } from "node:crypto";

import { ConnectorError, type GenericConnector } from "../connector-contract.js";

import { log } from "./log.js";
import type { ReleaseLedger } from "./release-ledger.js";
import { checkExternalRelease, isSignedExternalRelease, type ExternalRelease } from "./release.js";

/** Largest result returned to parmana-core, in bytes. Parmana refuses anything larger. */
const RESULT_LIMIT_BYTES = 16 * 1024;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** Longest connector message written to the log, in characters. */
const LOG_DETAIL_LIMIT = 300;

export interface ServiceOptions {
  readonly publicKey: KeyObject;
  readonly audience: string;
  /** Records each release and its first answer. Must be shared across instances. */
  readonly releaseLedger: ReleaseLedger;
  readonly connector: GenericConnector;
  /** The name the credential is listed under, for the credential handle. */
  readonly credentialId: string;
  /** Returns the connector's credential. Called per release and never logged. */
  readonly resolveCredential: () => string;
  readonly timeoutMs: number;
  readonly maxBodyBytes?: number;
  /** Injectable for tests. */
  readonly now?: () => Date;
}

/**
 * The HTTP surface. POST /execute accepts a signed release and nothing else.
 * GET /health reports that the process is up; it does not check the database
 * or the upstream system.
 */
export function createService(options: ServiceOptions) {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = options.now ?? (() => new Date());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { status: "UP" });
    }
    if (req.method !== "POST" || req.url !== "/execute") {
      return send(res, 404, { error: "not found" });
    }

    const body = await readBody(req, maxBodyBytes);
    if (body === "too-large") {
      return send(res, 413, { error: "request body is larger than the limit" });
    }
    if (body === undefined || !isSignedExternalRelease(body)) {
      return send(res, 400, { error: "request body is not a signed release" });
    }

    const check = await checkExternalRelease(body, {
      publicKey: options.publicKey,
      audience: options.audience,
      capabilities: options.connector.capabilities,
      now: now(),
    });
    if (!check.valid) {
      log("release_refused", { reasons: check.errors.length });
      return send(res, 403, { error: "release refused", errors: check.errors });
    }

    // A repeat gets the first answer, and the connector does not run again (G-132).
    let claim;
    try {
      claim = await options.releaseLedger.claim(check.release.businessTransactionId, check.release.expiresAt);
    } catch {
      // The ledger is unavailable. Nothing has run, so the caller may retry the same release.
      log("release_check_unavailable");
      return send(res, 500, { error: "internal error" });
    }
    if (!claim.claimed) {
      log("release_repeated", { businessTransactionId: check.release.businessTransactionId, capability: check.release.capability });
      if (claim.answer !== undefined) return send(res, 200, claim.answer);
      return send(res, 409, { error: "this release is already being executed; retry later" });
    }

    return answer(check.release, res);
  }

  async function answer(release: ExternalRelease, res: ServerResponse): Promise<void> {
    let success = true;
    let result: Record<string, unknown>;

    try {
      const response = await options.connector.execute(
        {
          capability: release.capability,
          parameters: release.parameters as Record<string, unknown>,
          target: release.target,
          businessTransactionId: release.businessTransactionId,
        },
        {
          credential: {
            providerId: "execution-service",
            credentialId: options.credentialId,
            value: options.resolveCredential(),
          },
          timeoutMs: options.timeoutMs,
        },
      );
      result = { status: response.metadata.status, body: response.metadata.body };
    } catch (err) {
      success = false;
      // Only the error code leaves the service. The detail stays in this log. It is the connector's own
      // message, capped in length. Connectors never put a credential or a response body in it.
      log("connector_failed", {
        businessTransactionId: release.businessTransactionId,
        capability: release.capability,
        code: err instanceof ConnectorError ? err.code : "unknown",
        detail: err instanceof ConnectorError ? err.message.slice(0, LOG_DETAIL_LIMIT) : "none",
      });
      result = { error: err instanceof ConnectorError ? `connector failed: ${err.code}` : "connector failed" };
    }

    if (Buffer.byteLength(JSON.stringify(result), "utf8") > RESULT_LIMIT_BYTES) {
      success = false;
      result = { error: "result is larger than 16 KB" };
    }

    log("release_answered", { businessTransactionId: release.businessTransactionId, capability: release.capability, success });
    const body = {
      businessTransactionId: release.businessTransactionId,
      capability: release.capability,
      success,
      result,
      executedAt: new Date().toISOString(),
    };
    try {
      await options.releaseLedger.complete(release.businessTransactionId, body);
    } catch {
      // The connector has run and the answer is in hand. A repeat finds the claim without an
      // answer and gets 409, so nothing runs twice. An operator resolves it.
      log("release_answer_not_stored", { businessTransactionId: release.businessTransactionId });
    }
    return send(res, 200, body);
  }

  return {
    handle,
    listen(port: number, host: string): Promise<Server> {
      const server = createServer((req, res) => {
        handle(req, res).catch(() => {
          log("unhandled_error");
          if (!res.headersSent) send(res, 500, { error: "internal error" });
        });
      });
      server.headersTimeout = 10_000;
      server.requestTimeout = 30_000;
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server));
      });
    },
  };
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | "too-large" | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) return "too-large";
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
