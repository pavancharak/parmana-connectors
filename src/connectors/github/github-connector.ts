import { createSign, createHash, type KeyObject } from "node:crypto";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector-contract.js";

/**
 * A connector for GitHub pull requests. It has the same shape as the generic
 * connector, so the execution service can run either one.
 *
 * Two capabilities:
 * - `github:pr-fetch` reads a pull request's mergeable state and head SHA.
 * - `github:pr-merge` merges a pull request. Merge methods are limited to
 *   merge, squash and rebase. If `expectedHeadSha` is given, GitHub refuses the
 *   merge when the head has moved since the decision was made.
 *
 * Authentication is a GitHub App. The credential value is
 * "<app id>:<installation id>:<base64 of the App's PEM private key>". For each
 * call, the connector signs a short-lived JWT, exchanges it for an installation
 * token, and uses that token once. The token is never stored, and it is never
 * shown in an error. The private key is base64 so the PEM's newlines fit in an
 * environment variable.
 *
 * The target is "<owner>/<repo>#<pull number>".
 */

export const GITHUB_PR_FETCH_CAPABILITY = "github:pr-fetch";
export const GITHUB_PR_MERGE_CAPABILITY = "github:pr-merge";

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_BUDGET_MS = 10_000;
const MERGE_METHODS: ReadonlySet<string> = new Set(["merge", "squash", "rebase"]);
const FETCH_PARAMETERS: ReadonlySet<string> = new Set([]);
const MERGE_PARAMETERS: ReadonlySet<string> = new Set(["mergeMethod", "expectedHeadSha"]);
const TARGET = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})#(\d{1,10})$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const USER_AGENT = "parmana-connector-github";

export interface GitHubConnectorOptions {
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Defaults to GitHub's public API. Tests may point it at a fake. */
  readonly baseUrl?: string;
}

export interface GitHubAppCredential {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyPem: string;
}

/** A fingerprint of an installation token, safe to show. Never a substring of it. */
export function githubTokenFingerprint(token: string): string {
  return `fp_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12)}`;
}

/** Reads the App credential. Refuses a malformed value without showing any part of it. */
export function parseGitHubAppCredential(value: string): GitHubAppCredential {
  const parts = value.split(":");
  if (parts.length !== 3) {
    throw new ConnectorError("credential_invalid", '"<app id>:<installation id>:<base64 private key>" is required. Its value is not shown.');
  }
  const [appId, installationId, keyBase64] = parts as [string, string, string];
  if (!/^\d{1,12}$/.test(appId) || !/^\d{1,12}$/.test(installationId)) {
    throw new ConnectorError("credential_invalid", "The GitHub App id and installation id must be numbers. Their values are not shown.");
  }
  const privateKeyPem = Buffer.from(keyBase64, "base64").toString("utf8");
  if (!privateKeyPem.includes("BEGIN") || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new ConnectorError("credential_invalid", "The GitHub App private key is not a PEM private key. Its value is not shown.");
  }
  return { appId, installationId, privateKeyPem };
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** An RS256 JWT for the App. Backdated 60 seconds and valid for 10 minutes, as GitHub recommends. */
export function signGitHubAppJwt(appId: string, privateKey: string | KeyObject, now: Date = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 600, iss: appId })));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function refuse(message: string): never {
  throw new ConnectorError("invalid_input", message);
}

function parseTarget(target: string | undefined): { owner: string; repo: string; pullNumber: string } {
  const match = target === undefined ? null : TARGET.exec(target);
  if (match === null || match[2] === "." || match[2] === "..") {
    refuse('The target must be "<owner>/<repo>#<pull number>".');
  }
  return { owner: match[1]!, repo: match[2]!, pullNumber: match[3]! };
}

export function createGitHubConnector(options: GitHubConnectorOptions = {}): GenericConnector {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  /** Exchanges the App's JWT for a short-lived installation token. Never stored. */
  async function mintInstallationToken(credential: GitHubAppCredential, signal: AbortSignal): Promise<string> {
    const jwt = signGitHubAppJwt(credential.appId, credential.privateKeyPem);
    const response = await doFetch(`${baseUrl}/app/installations/${encodeURIComponent(credential.installationId)}/access_tokens`, {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": USER_AGENT },
    }).catch(() => {
      throw new ConnectorError("timeout", "GitHub did not answer the token request in time. Nothing was sent to the pull request.");
    });
    if (!response.ok) {
      throw new ConnectorError("credential_invalid", `GitHub refused the App token request (HTTP ${response.status}). Its key or installation may be wrong.`);
    }
    const body = (await response.json().catch(() => undefined)) as { token?: unknown } | undefined;
    if (typeof body?.token !== "string" || body.token.length === 0) {
      throw new ConnectorError("credential_invalid", "GitHub returned no installation token.");
    }
    return body.token;
  }

  async function call(path: string, method: "GET" | "PUT", token: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<Response> {
    return doFetch(`${baseUrl}${path}`, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  return {
    system: "github",
    capabilities: [GITHUB_PR_FETCH_CAPABILITY, GITHUB_PR_MERGE_CAPABILITY],

    async execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse> {
      const allowed = request.capability === GITHUB_PR_FETCH_CAPABILITY ? FETCH_PARAMETERS : request.capability === GITHUB_PR_MERGE_CAPABILITY ? MERGE_PARAMETERS : null;
      if (allowed === null) {
        throw new ConnectorError("unknown_capability", `The GitHub connector does not run "${request.capability}".`);
      }
      for (const name of Object.keys(request.parameters)) {
        if (!allowed.has(name)) refuse(`Parameter "${name}" is not allowed for ${request.capability}.`);
      }

      const { owner, repo, pullNumber } = parseTarget(request.target);
      const credential = parseGitHubAppCredential(context.credential.value);

      let mergeBody: Record<string, unknown> | undefined;
      if (request.capability === GITHUB_PR_MERGE_CAPABILITY) {
        const method = request.parameters["mergeMethod"];
        if (typeof method !== "string" || !MERGE_METHODS.has(method)) {
          refuse("mergeMethod must be one of merge, squash, rebase.");
        }
        const expected = request.parameters["expectedHeadSha"];
        if (expected !== undefined && (typeof expected !== "string" || !HEAD_SHA.test(expected))) {
          refuse("expectedHeadSha must be a 40 character lowercase commit SHA.");
        }
        mergeBody = { merge_method: method, ...(expected !== undefined ? { sha: expected } : {}) };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_BUDGET_MS);
      const pullPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`;

      try {
        const token = await mintInstallationToken(credential, controller.signal);
        const fingerprint = githubTokenFingerprint(token);

        if (mergeBody === undefined) {
          const response = await call(pullPath, "GET", token, controller.signal);
          if (!response.ok) throw new ConnectorError("upstream_error", `GitHub returned HTTP ${response.status} for the pull request.`);
          const pull = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
          const head = pull?.["head"] as { sha?: unknown } | undefined;
          if (pull === undefined || typeof head?.sha !== "string") {
            throw new ConnectorError("upstream_error", "GitHub returned a pull request without a head SHA.");
          }
          return {
            success: true,
            metadata: {
              status: response.status,
              body: {
                number: pull["number"] ?? null,
                mergeable: typeof pull["mergeable"] === "boolean" ? pull["mergeable"] : null,
                mergedAt: typeof pull["merged_at"] === "string" ? pull["merged_at"] : null,
                headSha: head.sha,
                baseRef: typeof (pull["base"] as { ref?: unknown } | undefined)?.ref === "string" ? (pull["base"] as { ref: string }).ref : null,
                tokenFingerprint: fingerprint,
              },
            },
          };
        }

        let response: Response;
        try {
          response = await call(`${pullPath}/merge`, "PUT", token, controller.signal, mergeBody);
        } catch {
          throw new ConnectorError("upstream_error", "The merge request may have reached GitHub, and no answer was read. Check the pull request before any other action.");
        }
        if (!response.ok) {
          throw new ConnectorError("upstream_error", `GitHub did not merge the pull request (HTTP ${response.status}). Check the pull request before any other action.`);
        }
        const answer = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
        if (answer?.["merged"] !== true) {
          throw new ConnectorError("upstream_error", "GitHub answered without confirming the merge. Check the pull request before any other action.");
        }
        return {
          success: true,
          metadata: {
            status: response.status,
            body: { merged: true, sha: typeof answer["sha"] === "string" ? answer["sha"] : null, tokenFingerprint: fingerprint },
          },
        };
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("upstream_error", "The GitHub connector failed unexpectedly. Check the pull request before any other action.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
