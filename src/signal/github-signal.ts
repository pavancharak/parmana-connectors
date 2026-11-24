import { signGitHubAppJwt, parseGitHubAppCredential } from "../connectors/github/github-connector.js";

import type { SignalAnswerMessage, SignalQueryMessage } from "./protocol.js";

/**
 * Answers the four GitHub facts the merge policy declares, from GitHub's own records, as a business
 * signal source (RFC-0023). Each answer is observed and valid for 60 seconds.
 *
 * The claims:
 * - "repo.authorized": the repository is in this service's allowed list. No GitHub call.
 * - "pr.branch-protected": the pull request's base branch has branch protection.
 * - "pr.reviews-complete": at the expected head commit, the required number of approving reviews is
 *   given, and no reviewer's latest review requests changes.
 * - "pr.checks-passing": at the expected head commit, every check run has completed with success,
 *   neutral or skipped, and every commit status is success.
 *
 * The head commit comes from the query's parameters (expectedHeadSha). A pull request whose head has
 * moved is not the one approved, so its review and check claims answer false.
 *
 * A GitHub call that fails, or an answer that is not what the source expects, throws
 * SignalUnavailableError. The caller answers unavailable. A value is never guessed.
 * The installation token is used once and not stored, and it never appears in an error or an answer.
 */

export const GITHUB_API = "https://api.github.com";
export const GITHUB_CLAIMS = [
  "repo.authorized",
  "pr.branch-protected",
  "pr.reviews-complete",
  "pr.checks-passing",
] as const;
export type GitHubClaim = (typeof GITHUB_CLAIMS)[number];

const VALID_FOR_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const TARGET = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})#(\d{1,10})$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

export class SignalUnavailableError extends Error {}

export interface GitHubSignalOptions {
  /** "<app id>:<installation id>:<base64 of the App's PEM key>". Held by this service only. */
  readonly credential: string;
  /** Repositories, "owner/repo", this source may answer for. Anything else answers false for repo.authorized. */
  readonly allowedRepositories: ReadonlySet<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly baseUrl?: string;
}

interface Target {
  readonly repo: string;
  readonly owner: string;
  readonly name: string;
  readonly number: string;
}

export async function answerGitHubSignal(
  query: SignalQueryMessage,
  options: GitHubSignalOptions,
): Promise<SignalAnswerMessage> {
  const base = {
    version: 1 as const,
    source: query.source,
    nonce: query.nonce,
    signalKey: query.signalKey,
    claim: query.claim,
    subject: query.subject,
  };

  if (!(GITHUB_CLAIMS as readonly string[]).includes(query.claim)) {
    throw new SignalUnavailableError(`this source does not establish "${query.claim}"`);
  }
  const target = parseSubject(query.subject);
  if (target === null) {
    return { ...base, status: "not_found", reason: "the subject is not owner/repo#number" };
  }

  const now = options.now ?? (() => new Date());
  const observedAt = now();
  const observed = (value: boolean): SignalAnswerMessage => ({
    ...base,
    status: "observed",
    value,
    observedAt: observedAt.toISOString(),
    validUntil: new Date(observedAt.getTime() + VALID_FOR_MS).toISOString(),
  });

  if (query.claim === "repo.authorized") {
    return observed(options.allowedRepositories.has(target.repo));
  }

  const expectedHeadSha = query.parameters?.["expectedHeadSha"];
  if (typeof expectedHeadSha !== "string" || !HEAD_SHA.test(expectedHeadSha)) {
    throw new SignalUnavailableError("the query does not carry a 40 character expectedHeadSha");
  }

  const client = await GitHubClient.open(options);
  const pull = await client.get(`/repos/${target.owner}/${target.name}/pulls/${target.number}`);
  if (pull.status === 404) {
    return { ...base, status: "not_found", reason: "GitHub has no pull request with this number" };
  }
  expectOk(pull, "the pull request read");
  const headSha = (pull.body as { head?: { sha?: unknown } }).head?.sha;
  const baseRef = (pull.body as { base?: { ref?: unknown } }).base?.ref;
  if (typeof headSha !== "string" || typeof baseRef !== "string") {
    throw new SignalUnavailableError("GitHub's pull request has no head or base");
  }

  const protection = await client.get(
    `/repos/${target.owner}/${target.name}/branches/${encodeURIComponent(baseRef)}/protection`,
  );
  if (protection.status !== 200 && protection.status !== 404) {
    throw new SignalUnavailableError(`GitHub answered HTTP ${protection.status} for the branch protection read`);
  }

  if (query.claim === "pr.branch-protected") {
    return observed(protection.status === 200);
  }

  if (headSha !== expectedHeadSha) {
    // The head has moved since the approval. The reviews and checks are for a different commit.
    return observed(false);
  }

  if (query.claim === "pr.reviews-complete") {
    const required =
      protection.status === 200
        ? ((protection.body as { required_pull_request_reviews?: { required_approving_review_count?: unknown } })
            .required_pull_request_reviews?.required_approving_review_count ?? 0)
        : 0;
    if (typeof required !== "number") throw new SignalUnavailableError("GitHub's required review count is not a number");
    const reviews = await client.getAll(
      `/repos/${target.owner}/${target.name}/pulls/${target.number}/reviews`,
      "the reviews read",
    );
    const latest = new Map<string, string>();
    for (const review of reviews) {
      const user = (review as { user?: { login?: unknown } }).user?.login;
      const state = (review as { state?: unknown }).state;
      const commit = (review as { commit_id?: unknown }).commit_id;
      if (typeof user !== "string" || typeof state !== "string") continue;
      if (commit !== expectedHeadSha) continue;
      latest.set(user, state);
    }
    const approvals = [...latest.values()].filter((state) => state === "APPROVED").length;
    const blocked = [...latest.values()].some((state) => state === "CHANGES_REQUESTED");
    return observed(!blocked && approvals >= required);
  }

  // pr.checks-passing
  const runs = await client.getAll(
    `/repos/${target.owner}/${target.name}/commits/${expectedHeadSha}/check-runs`,
    "the check runs read",
    "check_runs",
  );
  const runsPass = runs.every((run) => {
    const r = run as { status?: unknown; conclusion?: unknown };
    return r.status === "completed" && typeof r.conclusion === "string" && PASSING_CONCLUSIONS.has(r.conclusion);
  });
  const combined = await client.get(`/repos/${target.owner}/${target.name}/commits/${expectedHeadSha}/status`);
  expectOk(combined, "the commit status read");
  const statuses = (combined.body as { statuses?: unknown; state?: unknown }).statuses;
  if (!Array.isArray(statuses)) throw new SignalUnavailableError("GitHub's commit status has no statuses list");
  const statusesPass = statuses.every((s) => (s as { state?: unknown }).state === "success");
  return observed(runsPass && statusesPass);
}

function parseSubject(subject: string): Target | null {
  const match = TARGET.exec(subject);
  if (match === null) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    owner: match[1]!,
    name: match[2]!,
    number: match[3]!,
  };
}

function expectOk(response: { status: number }, what: string): void {
  if (response.status < 200 || response.status > 299) {
    throw new SignalUnavailableError(`GitHub answered HTTP ${response.status} for ${what}`);
  }
}

/** A read-only client for one call's worth of GitHub reads, with one installation token. */
class GitHubClient {
  private constructor(
    private readonly token: string,
    private readonly doFetch: typeof fetch,
    private readonly baseUrl: string,
  ) {}

  static async open(options: GitHubSignalOptions): Promise<GitHubClient> {
    const doFetch = options.fetch ?? fetch;
    const baseUrl = options.baseUrl ?? GITHUB_API;
    let credential;
    try {
      credential = parseGitHubAppCredential(options.credential);
    } catch {
      throw new SignalUnavailableError("the GitHub App credential is malformed");
    }
    const jwt = signGitHubAppJwt(credential.appId, credential.privateKeyPem);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/app/installations/${encodeURIComponent(credential.installationId)}/access_tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      throw new SignalUnavailableError("GitHub did not answer the token request");
    }
    if (!response.ok) throw new SignalUnavailableError(`GitHub refused the App token request (HTTP ${response.status})`);
    const body = (await response.json().catch(() => undefined)) as { token?: unknown } | undefined;
    if (typeof body?.token !== "string" || body.token.length === 0) {
      throw new SignalUnavailableError("GitHub returned no installation token");
    }
    return new GitHubClient(body.token, doFetch, baseUrl);
  }

  async get(path: string): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      throw new SignalUnavailableError("GitHub did not answer a read in time");
    }
    const body: unknown = await response.json().catch(() => undefined);
    return { status: response.status, body };
  }

  /** Reads every page of a list. A list longer than one page is read until a short page is returned. */
  async getAll(path: string, what: string, key?: string): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.get(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      expectOk(response, what);
      const list = key === undefined ? response.body : (response.body as Record<string, unknown>)?.[key];
      if (!Array.isArray(list)) throw new SignalUnavailableError(`GitHub's ${what} was not a list`);
      items.push(...list);
      if (list.length < PAGE_SIZE) return items;
    }
    throw new SignalUnavailableError(`GitHub's ${what} is longer than this source reads`);
  }
}
