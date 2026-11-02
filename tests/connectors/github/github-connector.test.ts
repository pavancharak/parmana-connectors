import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import { GITHUB_PR_FETCH_CAPABILITY, GITHUB_PR_MERGE_CAPABILITY, createGitHubConnector, githubTokenFingerprint, parseGitHubAppCredential, signGitHubAppJwt } from "../../../src/connectors/github/github-connector.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "424242";
const INSTALLATION_ID = "99887766";
const CREDENTIAL = `${APP_ID}:${INSTALLATION_ID}:${Buffer.from(PEM, "utf8").toString("base64")}`;
const INSTALL_TOKEN = "fake-installation-token-for-tests";
const SHA = "a".repeat(40);
const TARGET = "acme/payments#17";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

/** A fake GitHub. `pull` is the PR it returns; `merge` is what the merge endpoint returns. */
function fakeGitHub(options: { pull?: Record<string, unknown>; merge?: unknown; mergeStatus?: number; tokenStatus?: number; tokenFails?: boolean; mergeFails?: boolean } = {}) {
  const sent: Sent[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ method: String(init?.method), path: url.pathname, authorization: headers["authorization"], body });

    if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      if (options.tokenFails) throw new Error("socket reset");
      if (options.tokenStatus !== undefined && options.tokenStatus !== 201) return new Response("{}", { status: options.tokenStatus });
      return new Response(JSON.stringify({ token: INSTALL_TOKEN }), { status: 201 });
    }
    if (url.pathname === "/repos/acme/payments/pulls/17" && init?.method === "GET") {
      return new Response(JSON.stringify(options.pull ?? { number: 17, mergeable: true, merged_at: null, head: { sha: SHA }, base: { ref: "main" } }), { status: 200 });
    }
    if (url.pathname === "/repos/acme/payments/pulls/17/merge" && init?.method === "PUT") {
      if (options.mergeFails) throw new Error("connection reset");
      return new Response(JSON.stringify(options.merge ?? { merged: true, sha: SHA, message: "Pull Request successfully merged" }), { status: options.mergeStatus ?? 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, sent };
}

function request(capability: string, parameters: Record<string, unknown> = {}, target: string | undefined = TARGET): ConnectorRequest {
  return { capability, parameters, target, businessTransactionId: "3b8f4c1e-2a7d-4e9b-9c6f-1d2e3f4a5b6c" };
}

function context(value: string = CREDENTIAL): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "GITHUB_APP_CREDENTIAL", value }, timeoutMs: 5_000 };
}

describe("github connector: app credential and JWT", () => {
  it("parses the App id, installation id and key", () => {
    const parsed = parseGitHubAppCredential(CREDENTIAL);
    expect(parsed.appId).toBe(APP_ID);
    expect(parsed.installationId).toBe(INSTALLATION_ID);
    expect(parsed.privateKeyPem).toContain("PRIVATE KEY");
  });

  it("refuses a malformed credential without showing it", () => {
    try {
      parseGitHubAppCredential("not-a-credential-value");
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).code).toBe("credential_invalid");
      expect((error as ConnectorError).message).not.toContain("not-a-credential");
    }
  });

  it("refuses a key that is not a PEM private key", () => {
    expect(() => parseGitHubAppCredential(`${APP_ID}:${INSTALLATION_ID}:${Buffer.from("hello", "utf8").toString("base64")}`)).toThrow(ConnectorError);
  });

  it("signs a JWT that verifies with the App's public key, RS256, with the App id as issuer", () => {
    const jwt = signGitHubAppJwt(APP_ID, PEM, new Date("2026-11-02T10:00:00Z"));
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string; exp: number; iat: number };
    expect(claims.iss).toBe(APP_ID);
    expect(claims.exp - claims.iat).toBe(660);
  });
});

describe("github connector: refusals before any call", () => {
  it("refuses another capability", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch, baseUrl: "https://api.example" }).execute(request("github:delete"), context())).rejects.toMatchObject({ code: "unknown_capability" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a target that is not owner/repo#number", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY, {}, "acme/../payments#17"), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a merge method other than merge, squash or rebase", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "force" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a head SHA that is not 40 lowercase hex characters", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "squash", expectedHeadSha: "not-a-sha" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a parameter that is not allowed for the capability", async () => {
    const fake = fakeGitHub();
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY, { mergeMethod: "merge" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });
});

describe("github connector: fetching a pull request", () => {
  it("reads mergeable state and the head SHA, with an installation token", async () => {
    const fake = fakeGitHub();
    const response = await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context());

    expect(response.metadata.body).toEqual({ number: 17, mergeable: true, mergedAt: null, headSha: SHA, baseRef: "main", tokenFingerprint: githubTokenFingerprint(INSTALL_TOKEN) });
    expect(fake.sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
      "GET /repos/acme/payments/pulls/17",
    ]);
    expect(fake.sent[1]?.authorization).toBe(`Bearer ${INSTALL_TOKEN}`);
  });

  it("refuses a pull request with no head SHA", async () => {
    const fake = fakeGitHub({ pull: { number: 17, mergeable: true } });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context())).rejects.toMatchObject({ code: "upstream_error" });
  });
});

describe("github connector: merging a pull request", () => {
  it("merges with the chosen method and the expected head SHA", async () => {
    const fake = fakeGitHub();
    const response = await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "squash", expectedHeadSha: SHA }), context());

    expect(response.metadata.body).toEqual({ merged: true, sha: SHA, tokenFingerprint: githubTokenFingerprint(INSTALL_TOKEN) });
    const merge = fake.sent.find((call) => call.method === "PUT");
    expect(merge?.path).toBe("/repos/acme/payments/pulls/17/merge");
    expect(merge?.body).toEqual({ merge_method: "squash", sha: SHA });
  });

  it("refuses a merge GitHub did not confirm", async () => {
    const fake = fakeGitHub({ merge: { merged: false, message: "Required status check is pending" } });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("tells the operator to check the pull request when the merge may have reached GitHub", async () => {
    const fake = fakeGitHub({ mergeFails: true });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context())).rejects.toThrow(/Check the pull request/);
  });

  it("reports an HTTP error from the merge endpoint as an error", async () => {
    const fake = fakeGitHub({ mergeStatus: 405 });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_MERGE_CAPABILITY, { mergeMethod: "merge" }), context())).rejects.toMatchObject({ code: "upstream_error" });
  });
});

describe("github connector: the token never shows", () => {
  it("does not show the App key, the installation token or the credential in any error", async () => {
    const fake = fakeGitHub({ tokenStatus: 401 });
    try {
      await createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context());
      expect.unreachable();
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain(INSTALL_TOKEN);
      expect(message).not.toContain("PRIVATE KEY");
      expect(message).not.toContain(CREDENTIAL);
    }
  });

  it("reports a token request that fails in transit as a timeout, before any PR call", async () => {
    const fake = fakeGitHub({ tokenFails: true });
    await expect(createGitHubConnector({ fetch: fake.fetch }).execute(request(GITHUB_PR_FETCH_CAPABILITY), context())).rejects.toMatchObject({ code: "timeout" });
    expect(fake.sent.map((call) => call.path)).not.toContain("/repos/acme/payments/pulls/17");
  });
});
