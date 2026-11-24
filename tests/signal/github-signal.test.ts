import { generateKeyPairSync, sign, verify } from "node:crypto";
import type { AddressInfo } from "node:net";

import { CanonicalSerializer } from "@parmana/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { answerGitHubSignal, SignalUnavailableError } from "../../src/signal/github-signal.js";
import { createGitHubSignalHttpServer } from "../../src/signal/github-signal-service.js";
import type { SignalQueryMessage } from "../../src/signal/protocol.js";

const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = appKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CREDENTIAL = `424242:99887766:${Buffer.from(APP_PEM, "utf8").toString("base64")}`;
const NOW = new Date("2026-11-24T12:00:00.000Z");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const TARGET = "acme/payments#17";
const ALLOWED = new Set(["acme/payments"]);

interface Fixture {
  readonly pullStatus?: number;
  readonly head?: string;
  readonly base?: string;
  readonly protectionStatus?: number;
  readonly requiredReviews?: number;
  readonly reviews?: unknown[];
  readonly checkRuns?: unknown[];
  readonly statuses?: unknown[];
  readonly tokenStatus?: number;
  readonly failPath?: string;
}

function fakeGitHub(f: Fixture = {}) {
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (f.failPath !== undefined && path.includes(f.failPath)) return new Response("{}", { status: 500 });
    if (path.endsWith("/access_tokens")) {
      if (f.tokenStatus !== undefined && f.tokenStatus !== 201) return new Response("{}", { status: f.tokenStatus });
      return new Response(JSON.stringify({ token: "fake-installation-token" }), { status: 201 });
    }
    if (path === "/repos/acme/payments/pulls/17") {
      if (f.pullStatus !== undefined && f.pullStatus !== 200) return new Response("{}", { status: f.pullStatus });
      return Response.json({ number: 17, head: { sha: f.head ?? HEAD }, base: { ref: f.base ?? "main" } });
    }
    if (path === "/repos/acme/payments/branches/main/protection") {
      if (f.protectionStatus === 404 || f.protectionStatus === undefined && f.requiredReviews === undefined) {
        return f.protectionStatus === 404 ? new Response("{}", { status: 404 }) : Response.json({ required_pull_request_reviews: { required_approving_review_count: f.requiredReviews ?? 1 } });
      }
      return Response.json({ required_pull_request_reviews: { required_approving_review_count: f.requiredReviews ?? 1 } });
    }
    if (path === "/repos/acme/payments/pulls/17/reviews") return Response.json(f.reviews ?? []);
    if (path === `/repos/acme/payments/commits/${HEAD}/check-runs`) return Response.json({ check_runs: f.checkRuns ?? [] });
    if (path === `/repos/acme/payments/commits/${HEAD}/status`) {
      return Response.json({ state: "success", statuses: f.statuses ?? [] });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return doFetch;
}

function query(claim: string, overrides: Partial<SignalQueryMessage> = {}, parameters: Record<string, unknown> = { expectedHeadSha: HEAD }): SignalQueryMessage {
  return {
    version: 1,
    source: "github-pull-requests",
    audience: "https://signal.example.test/github",
    signalKey: claim,
    claim,
    subject: TARGET,
    action: "github:pr-merge",
    businessTransactionId: "btx-1",
    nonce: "nonce-1",
    issuedAt: "2026-11-24T11:59:50.000Z",
    expiresAt: "2026-11-24T12:00:50.000Z",
    parameters,
    ...overrides,
  };
}

function answer(claim: string, f: Fixture = {}, parameters?: Record<string, unknown>) {
  return answerGitHubSignal(query(claim, {}, parameters), {
    credential: CREDENTIAL,
    allowedRepositories: ALLOWED,
    fetch: fakeGitHub(f),
    now: () => NOW,
  });
}

describe("repo.authorized", () => {
  it("holds for an allowed repository, with no GitHub call", async () => {
    const result = await answerGitHubSignal(query("repo.authorized"), { credential: CREDENTIAL, allowedRepositories: ALLOWED, fetch: fakeGitHub({ failPath: "/" }), now: () => NOW });
    expect(result).toMatchObject({ status: "observed", value: true });
  });

  it("does not hold for another repository", async () => {
    const result = await answerGitHubSignal({ ...query("repo.authorized"), subject: "other/repo#1" }, { credential: CREDENTIAL, allowedRepositories: ALLOWED, fetch: fakeGitHub(), now: () => NOW });
    expect(result).toMatchObject({ status: "observed", value: false });
  });
});

describe("pr.branch-protected", () => {
  it("holds when the base branch has protection", async () => {
    expect(await answer("pr.branch-protected", { protectionStatus: 200 })).toMatchObject({ status: "observed", value: true });
  });

  it("does not hold when the base branch has no protection", async () => {
    expect(await answer("pr.branch-protected", { protectionStatus: 404 })).toMatchObject({ status: "observed", value: false });
  });
});

describe("pr.reviews-complete", () => {
  const approved = [{ user: { login: "reviewer-1" }, state: "APPROVED", commit_id: HEAD }];

  it("holds when the required approvals are on the expected head", async () => {
    expect(await answer("pr.reviews-complete", { requiredReviews: 1, reviews: approved })).toMatchObject({ value: true });
  });

  it("does not hold when the approval is on an older commit", async () => {
    const old = [{ user: { login: "reviewer-1" }, state: "APPROVED", commit_id: OLD }];
    expect(await answer("pr.reviews-complete", { requiredReviews: 1, reviews: old })).toMatchObject({ value: false });
  });

  it("does not hold when a reviewer's latest review requests changes", async () => {
    const changed = [
      { user: { login: "reviewer-1" }, state: "APPROVED", commit_id: HEAD },
      { user: { login: "reviewer-1" }, state: "CHANGES_REQUESTED", commit_id: HEAD },
    ];
    expect(await answer("pr.reviews-complete", { requiredReviews: 1, reviews: changed })).toMatchObject({ value: false });
  });

  it("does not hold when fewer approvals than required", async () => {
    expect(await answer("pr.reviews-complete", { requiredReviews: 2, reviews: approved })).toMatchObject({ value: false });
  });

  it("does not hold when the head has moved past the approved commit", async () => {
    expect(await answer("pr.reviews-complete", { head: OLD, requiredReviews: 1, reviews: approved })).toMatchObject({ value: false });
  });
});

describe("pr.checks-passing", () => {
  const passing = [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }];

  it("holds when every check run passed and every status is success", async () => {
    expect(await answer("pr.checks-passing", { checkRuns: passing, statuses: [{ state: "success" }] })).toMatchObject({ value: true });
  });

  it("does not hold when a check run failed", async () => {
    expect(await answer("pr.checks-passing", { checkRuns: [...passing, { status: "completed", conclusion: "failure" }] })).toMatchObject({ value: false });
  });

  it("does not hold while a check run is still running", async () => {
    expect(await answer("pr.checks-passing", { checkRuns: [{ status: "in_progress", conclusion: null }] })).toMatchObject({ value: false });
  });

  it("does not hold when a commit status is pending", async () => {
    expect(await answer("pr.checks-passing", { checkRuns: passing, statuses: [{ state: "pending" }] })).toMatchObject({ value: false });
  });
});

describe("answers that are not values", () => {
  it("answers not_found for a pull request GitHub does not have", async () => {
    expect(await answer("pr.branch-protected", { pullStatus: 404 })).toMatchObject({ status: "not_found" });
  });

  it("throws unavailable when GitHub fails to answer the pull request read", async () => {
    await expect(answer("pr.branch-protected", { failPath: "/pulls/17" })).rejects.toBeInstanceOf(SignalUnavailableError);
  });

  it("throws unavailable when GitHub refuses the token", async () => {
    await expect(answer("pr.branch-protected", { tokenStatus: 401 })).rejects.toBeInstanceOf(SignalUnavailableError);
  });

  it("throws unavailable for a claim this source does not establish", async () => {
    await expect(answer("payment.refundable")).rejects.toBeInstanceOf(SignalUnavailableError);
  });

  it("throws unavailable for a check without an expected head commit", async () => {
    await expect(answer("pr.checks-passing", {}, {})).rejects.toBeInstanceOf(SignalUnavailableError);
  });

  it("never shows the installation token or the App key in an answer", async () => {
    const result = await answer("pr.branch-protected", { protectionStatus: 200 });
    expect(JSON.stringify(result)).not.toContain("fake-installation-token");
    expect(JSON.stringify(result)).not.toContain("99887766");
  });
});

describe("the HTTP service, end to end", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("answers a signed query with a signed answer, and refuses an unsigned one", async () => {
    const parmana = generateKeyPairSync("ed25519");
    const signing = generateKeyPairSync("ed25519");
    const server = createGitHubSignalHttpServer({
      audience: "https://signal.example.test/github",
      parmanaPublicKeyPem: parmana.publicKey.export({ type: "spki", format: "pem" }).toString(),
      signingKeyPem: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      signingKeyId: "signal-1",
      credential: CREDENTIAL,
      allowedRepositories: ALLOWED,
      fetch: fakeGitHub({ protectionStatus: 200 }),
      now: () => new Date(),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/`;

    const q = { ...query("pr.branch-protected"), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
    const signature = sign(null, Buffer.from(new CanonicalSerializer().serialize(q)), parmana.privateKey).toString("base64");
    const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, signature: { algorithm: "ed25519", keyId: "default", value: signature } }) });
    expect(ok.status).toBe(200);
    const signed = (await ok.json()) as { answer: { value: boolean }; signature: { value: string } };
    expect(signed.answer.value).toBe(true);
    const answerValid = verify(null, Buffer.from(new CanonicalSerializer().serialize(signed.answer as never)), signing.publicKey, Buffer.from(signed.signature.value, "base64"));
    expect(answerValid).toBe(true);

    const unsigned = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
    expect(unsigned.status).toBe(403);
  });
});
