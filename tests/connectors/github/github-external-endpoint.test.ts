import { generateKeyPairSync, sign } from "node:crypto";

import { canonicalSerialize } from "@parmana/sdk";
import { describe, expect, it } from "vitest";

import { createGitHubReleaseEndpoint } from "../../../src/connectors/github/external-endpoint.js";

const AUDIENCE = "https://github-connector.example.test/release";
const KEY_ID = "default";
const CREDENTIAL = `424242:99887766:${Buffer.from(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  "utf8",
).toString("base64")}`;
const NOW = new Date("2026-11-24T12:00:00.000Z");
const SHA = "a".repeat(40);

const parmana = generateKeyPairSync("ed25519");
const PUBLIC_PEM = parmana.publicKey.export({ type: "spki", format: "pem" }).toString();

interface Sent {
  readonly method: string;
  readonly path: string;
}

function fakeGitHub(options: { pullStatus?: number } = {}) {
  const sent: Sent[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ method: String(init?.method), path: url.pathname });
    if (url.pathname.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "fake-installation-token" }), { status: 201 });
    }
    if (url.pathname === "/repos/acme/payments/pulls/17" && init?.method === "GET") {
      const body = { number: 17, mergeable: true, merged_at: null, head: { sha: SHA }, base: { ref: "main" } };
      return new Response(JSON.stringify(body), { status: options.pullStatus ?? 200 });
    }
    if (url.pathname === "/repos/acme/payments/pulls/17/merge" && init?.method === "PUT") {
      return new Response(JSON.stringify({ merged: true, sha: SHA }), { status: 200 });
    }
    if (url.pathname === "/repos/acme/payments/issues/17/comments" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: 555, html_url: "https://github.com/acme/payments/pull/17#issuecomment-555" }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, sent };
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    connectorId: "github",
    audience: AUDIENCE,
    businessTransactionId: "btx-github-1",
    authorizationId: "auth-github-1",
    capability: "github:pr-fetch",
    target: "acme/payments#17",
    parameters: {},
    policy: { name: "github-pr-read", version: "1.1.0" },
    approvedBy: [{ approverId: "approver-1", keyId: "approver-key-1", approvalId: "approval-1" }],
    issuedAt: "2026-11-24T11:59:00.000Z",
    expiresAt: "2026-11-24T12:05:00.000Z",
    ...overrides,
  };
}

/** A body signed the way Parmana signs a release: ed25519 over the canonical JSON. */
function signed(body: Record<string, unknown>, key = parmana.privateKey) {
  const signature = sign(null, Buffer.from(canonicalSerialize(body as never)), key).toString("base64");
  return { release: body, signature: { algorithm: "ed25519", keyId: KEY_ID, value: signature } };
}

function endpoint(fake = fakeGitHub(), answers = new Map<string, Record<string, unknown>>()) {
  return {
    handle: createGitHubReleaseEndpoint({
      publicKeys: { [KEY_ID]: PUBLIC_PEM },
      audience: AUDIENCE,
      credential: CREDENTIAL,
      fetch: fake.fetch,
      answers,
      now: () => NOW,
    }),
    fake,
    answers,
  };
}

describe("GitHub release endpoint: a valid release", () => {
  it("acts with github:pr-fetch and answers with the real pull request fields", async () => {
    const { handle, fake } = endpoint();
    const answer = await handle(signed(release()));

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ businessTransactionId: "btx-github-1", success: true, result: { headSha: SHA, baseRef: "main" } });
    expect(fake.sent.map((call) => `${call.method} ${call.path}`)).toContain("GET /repos/acme/payments/pulls/17");
  });

  it("never returns the GitHub App credential or the installation token", async () => {
    const { handle } = endpoint();
    const answer = await handle(signed(release()));

    expect(JSON.stringify(answer)).not.toContain("fake-installation-token");
    expect(JSON.stringify(answer)).not.toContain("99887766");
  });
});

describe("GitHub release endpoint: refusals before any GitHub call", () => {
  it("refuses a body whose signature does not verify, and calls GitHub zero times", async () => {
    const other = generateKeyPairSync("ed25519");
    const { handle, fake } = endpoint();
    const answer = await handle(signed(release(), other.privateKey));

    expect(answer.status).toBe(401);
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a release for another audience", async () => {
    const { handle, fake } = endpoint();
    const answer = await handle(signed(release({ audience: "https://somewhere-else.example.test/release" })));

    expect(answer.status).toBe(401);
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses an expired release", async () => {
    const { handle, fake } = endpoint();
    const answer = await handle(signed(release({ expiresAt: "2026-11-24T11:00:00.000Z" })));

    expect(answer.status).toBe(401);
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a capability this endpoint does not serve, and calls GitHub zero times", async () => {
    const { handle, fake } = endpoint();
    const answer = await handle(signed(release({ capability: "github:pr-delete", parameters: {} })));

    expect(answer.status).toBe(403);
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a body that is not { release, signature }", async () => {
    const { handle } = endpoint();
    expect((await handle({ hello: "world" })).status).toBe(401);
  });
});

describe("GitHub release endpoint: the two writes", () => {
  it("merges with the approved method and head SHA, and answers with merged true", async () => {
    const { handle, fake } = endpoint();
    const answer = await handle(
      signed(release({ businessTransactionId: "btx-merge-1", capability: "github:pr-merge", parameters: { mergeMethod: "squash", expectedHeadSha: SHA } })),
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ success: true, result: { merged: true, sha: SHA } });
    const merge = fake.sent.find((call) => call.method === "PUT");
    expect(merge?.path).toBe("/repos/acme/payments/pulls/17/merge");
  });

  it("posts a comment with the transaction marker, and answers with the comment id", async () => {
    const { handle, fake } = endpoint();
    const answer = await handle(
      signed(release({ businessTransactionId: "btx-comment-1", capability: "github:comment", parameters: { body: "Approved and released." } })),
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ success: true, result: { commentId: 555 } });
    expect(fake.sent.some((call) => call.method === "POST" && call.path.endsWith("/comments"))).toBe(true);
  });

  it("refuses a merge with an unknown parameter, and calls GitHub zero times", async () => {
    const { handle, fake } = endpoint();
    const answer = await handle(
      signed(release({ businessTransactionId: "btx-merge-bad", capability: "github:pr-merge", parameters: { mergeMethod: "merge", body: "x" } })),
    );

    // The connector refuses the parameter, so the answer is a recorded failure, not a GitHub call.
    expect(answer.body).toMatchObject({ success: false, errorCode: "invalid_input" });
    expect(fake.sent.some((call) => call.method === "PUT")).toBe(false);
  });
});

describe("GitHub release endpoint: a replay", () => {
  it("answers a repeated release with the first answer, and does not call GitHub again", async () => {
    const { handle, fake } = endpoint();
    const body = signed(release());

    const first = await handle(body);
    const second = await handle(body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(fake.sent.filter((call) => call.path === "/repos/acme/payments/pulls/17")).toHaveLength(1);
  });

  it("records a failed GitHub call as the first answer, so a replay cannot act again", async () => {
    const { handle, fake } = endpoint(fakeGitHub({ pullStatus: 404 }));
    const body = signed(release());

    const first = await handle(body);
    const second = await handle(body);

    expect(first.body).toMatchObject({ success: false, errorCode: "upstream_error" });
    expect(second.body).toEqual(first.body);
    expect(fake.sent.filter((call) => call.path === "/repos/acme/payments/pulls/17")).toHaveLength(1);
  });
});
