import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import { GITHUB_COMMENT_CAPABILITY, createGitHubConnector } from "../../../src/connectors/github/github-connector.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const INSTALLATION_ID = "99887766";
const CREDENTIAL = `424242:${INSTALLATION_ID}:${Buffer.from(PEM, "utf8").toString("base64")}`;
const INSTALL_TOKEN = "fake-installation-token-for-comment-tests";
const TARGET = "pavancharak/parmana-github-test#7";

function fakeGitHub(
  options: { commentStatus?: number; commentFails?: boolean; commentHangs?: boolean; commentReply?: string; tokenStatus?: number } = {},
) {
  const posted: { path: string; body: unknown; authorization: string | undefined }[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      if (options.tokenStatus !== undefined && options.tokenStatus !== 201) return new Response("{}", { status: options.tokenStatus });
      return new Response(JSON.stringify({ token: INSTALL_TOKEN }), { status: 201 });
    }
    if (url.pathname === "/repos/pavancharak/parmana-github-test/issues/7/comments" && init?.method === "POST") {
      posted.push({ path: url.pathname, body: JSON.parse(String(init.body)), authorization: headers["authorization"] });
      if (options.commentFails) throw new Error("connection reset");
      if (options.commentHangs) {
        // Never answers; the connector's timeout must abort the wait.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (options.commentReply !== undefined) return new Response(options.commentReply, { status: options.commentStatus ?? 201 });
      return new Response(JSON.stringify({ id: 555, html_url: "https://github.com/pavancharak/parmana-github-test/pull/7#issuecomment-555" }), {
        status: options.commentStatus ?? 201,
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, posted };
}

const context: ConnectorExecutionContext = { credential: { providerId: "test", credentialId: "gh", value: CREDENTIAL }, timeoutMs: 5000 };

function request(parameters: Record<string, unknown>, target: string | undefined = TARGET): ConnectorRequest {
  return { capability: GITHUB_COMMENT_CAPABILITY, parameters, target, businessTransactionId: "btx-1" };
}

describe("github:comment is listed", () => {
  it("is advertised", () => {
    expect(createGitHubConnector().capabilities).toContain(GITHUB_COMMENT_CAPABILITY);
  });
});

describe("github:comment posts one comment", () => {
  it("posts the body through the App's installation token and returns the comment id", async () => {
    const fake = fakeGitHub();
    const result = await createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" }).execute(request({ body: "Approved by Parmana" }), context);
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.body).toEqual({ body: "Approved by Parmana\n\n<!-- parmana:btx=btx-1 -->" });
    expect(fake.posted[0]!.authorization).toBe(`Bearer ${INSTALL_TOKEN}`);
    expect(result.metadata.body).toMatchObject({ commentId: 555 });
    expect(JSON.stringify(result)).not.toContain(INSTALL_TOKEN);
  });

  it("refuses an empty or oversized body before any call", async () => {
    const fake = fakeGitHub();
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    await expect(connector.execute(request({ body: "   " }), context)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(connector.execute(request({ body: "x".repeat(4001) }), context)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.posted).toHaveLength(0);
  });

  it("marks the comment with the transaction id so it can be found later", async () => {
    const fake = fakeGitHub();
    await createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" }).execute(request({ body: "Hello" }), context);
    expect(String((fake.posted[0]!.body as { body: string }).body)).toContain("<!-- parmana:btx=btx-1 -->");
  });

  it("refuses a missing or unsafe transaction id before any call", async () => {
    const fake = fakeGitHub();
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    const missing: ConnectorRequest = { capability: GITHUB_COMMENT_CAPABILITY, parameters: { body: "ok" }, target: TARGET };
    await expect(connector.execute(missing, context)).rejects.toMatchObject({ code: "invalid_input" });
    const unsafe: ConnectorRequest = { ...request({ body: "ok" }), businessTransactionId: "x --> injected" };
    await expect(connector.execute(unsafe, context)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.posted).toHaveLength(0);
  });

  it("refuses any parameter other than body", async () => {
    const fake = fakeGitHub();
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    await expect(connector.execute(request({ body: "ok", mergeMethod: "squash" }), context)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.posted).toHaveLength(0);
  });

  it("refuses a malformed target", async () => {
    const fake = fakeGitHub();
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    await expect(connector.execute(request({ body: "ok" }, "pavancharak/parmana-github-test"), context)).rejects.toBeInstanceOf(ConnectorError);
    expect(fake.posted).toHaveLength(0);
  });

  it("reports an unanswered comment as possibly sent, and does not retry", async () => {
    const fake = fakeGitHub({ commentFails: true });
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    await expect(connector.execute(request({ body: "ok" }), context)).rejects.toMatchObject({ code: "upstream_error" });
    expect(fake.posted).toHaveLength(1);
  });

  it("reports a refused comment as an upstream error", async () => {
    const fake = fakeGitHub({ commentStatus: 403 });
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    await expect(connector.execute(request({ body: "ok" }), context)).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("accepts a body of exactly the maximum length", async () => {
    const fake = fakeGitHub();
    await createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" }).execute(request({ body: "x".repeat(4000) }), context);
    expect(fake.posted).toHaveLength(1);
  });

  it("reports a reply that carries no comment id as unconfirmed, and does not retry", async () => {
    const fake = fakeGitHub({ commentReply: JSON.stringify({ message: "ok" }) });
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    await expect(connector.execute(request({ body: "ok" }), context)).rejects.toMatchObject({ code: "upstream_error" });
    expect(fake.posted).toHaveLength(1);
  });

  it("reports a reply that is not JSON as unconfirmed, and does not retry", async () => {
    const fake = fakeGitHub({ commentReply: "<html>bad gateway</html>" });
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    await expect(connector.execute(request({ body: "ok" }), context)).rejects.toMatchObject({ code: "upstream_error" });
    expect(fake.posted).toHaveLength(1);
  });

  it("reports a comment that never gets an answer as possibly sent, once the timeout passes", async () => {
    const fake = fakeGitHub({ commentHangs: true });
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    const hungContext: ConnectorExecutionContext = { ...context, timeoutMs: 50 };
    const error = await connector.execute(request({ body: "ok" }), hungContext).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "upstream_error" });
    expect(String((error as Error).message)).toContain("may have reached GitHub");
    expect(fake.posted).toHaveLength(1);
  });

  it("refuses when GitHub will not issue a token, without showing the credential", async () => {
    const fake = fakeGitHub({ tokenStatus: 401 });
    const connector = createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://gh.test" });
    const error = await connector.execute(request({ body: "ok" }), context).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "credential_invalid" });
    expect(String((error as Error).message)).not.toContain(CREDENTIAL);
    expect(fake.posted).toHaveLength(0);
  });
});
