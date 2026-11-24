import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import {
  GITHUB_COMMENT_CAPABILITY,
  GITHUB_PR_FETCH_CAPABILITY,
  GITHUB_PR_MERGE_CAPABILITY,
  createGitHubConnector,
  githubTokenFingerprint,
} from "../../../src/connectors/github/github-connector.js";

// One test block per capability, covering every refusal and every GitHub
// answer the connector handles. The existing github-connector.test.ts and
// github-comment.test.ts cover the App credential and the comment body.

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "424242";
const INSTALLATION_ID = "99887766";
const CREDENTIAL = `${APP_ID}:${INSTALLATION_ID}:${Buffer.from(PEM, "utf8").toString("base64")}`;
const INSTALL_TOKEN = "fake-installation-token-for-tests";
const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TARGET = "acme/payments#17";
const PULL_PATH = "/repos/acme/payments/pulls/17";
const TOKEN_PATH = `/app/installations/${INSTALLATION_ID}/access_tokens`;
const BTX = "3b8f4c1e-2a7d-4e9b-9c6f-1d2e3f4a5b6c";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}

interface FakeOptions {
  readonly tokenStatus?: number;
  readonly pullStatus?: number;
  readonly pull?: unknown;
  readonly mergeStatus?: number;
  readonly merge?: unknown;
  readonly commentStatus?: number;
  readonly comment?: unknown;
}

/** A fake GitHub that records every request, so a test can show what was sent and what was not. */
function fakeGitHub(options: FakeOptions = {}) {
  const sent: Sent[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ method: String(init?.method), path: url.pathname, body });

    if (url.pathname === TOKEN_PATH) {
      if (options.tokenStatus !== undefined && options.tokenStatus !== 201) {
        return new Response("{}", { status: options.tokenStatus });
      }
      return new Response(JSON.stringify({ token: INSTALL_TOKEN }), { status: 201 });
    }
    if (url.pathname === PULL_PATH && init?.method === "GET") {
      const pull = options.pull ?? { number: 17, mergeable: true, merged_at: null, head: { sha: HEAD_SHA }, base: { ref: "main" } };
      return new Response(JSON.stringify(pull), { status: options.pullStatus ?? 200 });
    }
    if (url.pathname === `${PULL_PATH}/merge` && init?.method === "PUT") {
      const answer = options.merge ?? { merged: true, sha: HEAD_SHA, message: "Pull Request successfully merged" };
      return new Response(JSON.stringify(answer), { status: options.mergeStatus ?? 200 });
    }
    if (url.pathname === "/repos/acme/payments/issues/17/comments" && init?.method === "POST") {
      const answer = options.comment ?? { id: 555, html_url: "https://github.com/acme/payments/pull/17#issuecomment-555" };
      return new Response(JSON.stringify(answer), { status: options.commentStatus ?? 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, sent };
}

function request(capability: string, parameters: Record<string, unknown> = {}, target: string | undefined = TARGET): ConnectorRequest {
  return { capability, parameters, target, businessTransactionId: BTX };
}

function context(value: string = CREDENTIAL): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "GITHUB_APP_CREDENTIAL", value }, timeoutMs: 5_000 };
}

/** The request paths the fake saw, in order. */
function paths(sent: Sent[]): string[] {
  return sent.map((call) => `${call.method} ${call.path}`);
}

describe("github:pr-fetch", () => {
  it("returns a pull request that is not yet mergeable, with mergeable null", async () => {
    const fake = fakeGitHub({ pull: { number: 17, mergeable: null, merged_at: null, head: { sha: HEAD_SHA }, base: { ref: "main" } } });
    const response = await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context());

    expect(response.metadata.body).toMatchObject({ mergeable: null, headSha: HEAD_SHA });
  });

  it("returns a merged pull request with its merged_at time", async () => {
    const mergedAt = "2026-11-20T10:00:00Z";
    const fake = fakeGitHub({ pull: { number: 17, mergeable: null, merged_at: mergedAt, head: { sha: HEAD_SHA }, base: { ref: "main" } } });
    const response = await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context());

    expect(response.metadata.body).toMatchObject({ mergedAt });
  });

  it("refuses any parameter, since fetch takes none, before any call", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY, { mergeMethod: "merge" }), context())).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a missing target before any call", async () => {
    const fake = fakeGitHub();
    // request() would substitute the default target for undefined, so the request is built directly here.
    const withoutTarget: ConnectorRequest = { capability: GITHUB_PR_FETCH_CAPABILITY, parameters: {}, businessTransactionId: BTX };
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(withoutTarget, context())).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fake.sent).toHaveLength(0);
  });

  it("reports a pull request GitHub does not find as an upstream error, with the status", async () => {
    const fake = fakeGitHub({ pullStatus: 404, pull: { message: "Not Found" } });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context())).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("HTTP 404"),
    });
  });

  it("refuses when GitHub will not issue a token, and sends no pull request call", async () => {
    const fake = fakeGitHub({ tokenStatus: 401 });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context())).rejects.toMatchObject({
      code: "credential_invalid",
    });
    expect(paths(fake.sent)).toEqual([`POST ${TOKEN_PATH}`]);
  });

  it("returns a fingerprint of the installation token, never the token", async () => {
    const fake = fakeGitHub();
    const response = await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context());

    expect(response.metadata.body).toMatchObject({ tokenFingerprint: githubTokenFingerprint(INSTALL_TOKEN) });
    expect(JSON.stringify(response)).not.toContain(INSTALL_TOKEN);
  });
});

describe("github:pr-merge", () => {
  it.each(["merge", "squash", "rebase"])("sends merge method %s to GitHub", async (mergeMethod) => {
    const fake = fakeGitHub();
    await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod }), context());

    const merge = fake.sent.find((call) => call.method === "PUT");
    expect(merge?.body).toEqual({ merge_method: mergeMethod });
  });

  it("sends the expected head SHA as sha when one is given", async () => {
    const fake = fakeGitHub();
    await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge", expectedHeadSha: HEAD_SHA }), context());

    expect(fake.sent.find((call) => call.method === "PUT")?.body).toEqual({ merge_method: "merge", sha: HEAD_SHA });
  });

  it("sends no sha when no expected head SHA is given", async () => {
    const fake = fakeGitHub();
    await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context());

    expect(fake.sent.find((call) => call.method === "PUT")?.body).not.toHaveProperty("sha");
  });

  it("refuses a missing merge method before any call", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { expectedHeadSha: HEAD_SHA }), context())).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses an expected head SHA in upper case, before any call", async () => {
    const fake = fakeGitHub();
    await expect(
      createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge", expectedHeadSha: HEAD_SHA.toUpperCase() }), context()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a parameter other than mergeMethod and expectedHeadSha, before any call", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge", body: "x" }), context())).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fake.sent).toHaveLength(0);
  });

  it("reports a merge refused because the head moved (409) as an error, not a success", async () => {
    const fake = fakeGitHub({ mergeStatus: 409, merge: { message: "Head branch was modified" } });
    await expect(
      createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge", expectedHeadSha: OTHER_SHA }), context()),
    ).rejects.toMatchObject({ code: "upstream_error", message: expect.stringContaining("HTTP 409") });
  });

  it("reports a merge answer with merged false as an error, not a success", async () => {
    const fake = fakeGitHub({ merge: { merged: false, message: "Pull Request is not mergeable" } });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context())).rejects.toMatchObject({
      code: "upstream_error",
    });
  });

  it("returns merged true with a null sha when GitHub does not name the merge commit", async () => {
    const fake = fakeGitHub({ merge: { merged: true, message: "ok" } });
    const response = await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context());

    expect(response.metadata.body).toMatchObject({ merged: true, sha: null });
  });

  it("refuses when GitHub will not issue a token, and sends no merge call", async () => {
    const fake = fakeGitHub({ tokenStatus: 403 });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context())).rejects.toMatchObject({
      code: "credential_invalid",
    });
    expect(fake.sent.some((call) => call.method === "PUT")).toBe(false);
  });

  it("never shows the installation token in a merge error", async () => {
    const fake = fakeGitHub({ mergeStatus: 422, merge: { message: "Unprocessable" } });
    const error = await createGitHubConnector({ fetch: fake.fetch })
      .execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConnectorError);
    expect(String((error as Error).message)).not.toContain(INSTALL_TOKEN);
  });
});

describe("github:comment (connector level)", () => {
  it("sends the body with the transaction marker as one POST to the issue comments endpoint", async () => {
    const fake = fakeGitHub();
    const response = await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_COMMENT_CAPABILITY, { body: "Released." }), context());

    expect(response.metadata.body).toMatchObject({ commentId: 555 });
    const post = fake.sent.find((call) => call.method === "POST" && call.path.endsWith("/comments"));
    expect(post?.body?.["body"]).toBe(`Released.\n\n<!-- parmana:btx=${BTX} -->`);
  });

  it("refuses a comment with no body before any call", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_COMMENT_CAPABILITY, {}), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });
});

describe("every capability", () => {
  it("advertises exactly the three GitHub capabilities", () => {
    const connector = createGitHubConnector({ fetch: fakeGitHub().fetch });

    expect(connector.system).toBe("github");
    expect(connector.capabilities).toEqual([GITHUB_PR_FETCH_CAPABILITY, GITHUB_PR_MERGE_CAPABILITY, GITHUB_COMMENT_CAPABILITY]);
  });

  it("refuses a capability it does not run, before any call", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request("github:pr-delete", {}), context())).rejects.toMatchObject({
      code: "unknown_capability",
    });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a malformed App credential before any call", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context("not-a-credential"))).rejects.toMatchObject({
      code: "credential_invalid",
    });
    expect(fake.sent).toHaveLength(0);
  });
});
