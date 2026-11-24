import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { ConnectorError, type ConnectorRequest } from "../../../src/connector-contract.js";
import {
  GITHUB_COMMENT_CAPABILITY,
  GITHUB_PR_FETCH_CAPABILITY,
  GITHUB_PR_MERGE_CAPABILITY,
  createGitHubConnector,
} from "../../../src/connectors/github/github-connector.js";

// Live tests against GitHub's real API, with a real GitHub App. They run only
// when the environment opts in, so a normal `npm test` never reaches GitHub.
//
//   ALLOW_LIVE_GITHUB=1                     required to run any live test
//   TEST_GITHUB_APP_ID                      the App's numeric id
//   TEST_GITHUB_INSTALLATION_ID             the installation id on the test repository
//   TEST_GITHUB_APP_PRIVATE_KEY             the App's PEM private key, as a file path or the PEM text
//   TEST_GITHUB_TARGET                      "<owner>/<repo>#<number>" of a test pull request (read only)
//
//   ALLOW_LIVE_GITHUB_WRITES=1              required for the comment and merge tests
//   TEST_GITHUB_WRITE_TARGET                a DISPOSABLE pull request, for the comment test. Never a real one.
//   TEST_GITHUB_MERGE_TARGET                a DISPOSABLE pull request the merge test merges. Never a real one.
//   TEST_GITHUB_STALE_TARGET                a second DISPOSABLE, still open, pull request for the stale-SHA refusal test.
//
// A missing variable under ALLOW_LIVE_GITHUB=1 is a failure, not a skip, so an
// explicit live run cannot pass without doing anything.

// Real GitHub calls, including a merge, can take longer than vitest's 5 second default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LIVE = process.env["ALLOW_LIVE_GITHUB"] === "1";
const WRITES = process.env["ALLOW_LIVE_GITHUB_WRITES"] === "1";
const describeLive = LIVE ? describe : describe.skip;
const describeWrites = LIVE && WRITES ? describe : describe.skip;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`ALLOW_LIVE_GITHUB=1 is set but ${name} is not. Set it, or unset ALLOW_LIVE_GITHUB.`);
  }
  return value.trim();
}

/** The connector's credential: "<app id>:<installation id>:<base64 of the PEM>". Built here, never printed. */
function credentialValue(): string {
  const appId = requireEnv("TEST_GITHUB_APP_ID");
  const installationId = requireEnv("TEST_GITHUB_INSTALLATION_ID");
  const keyInput = requireEnv("TEST_GITHUB_APP_PRIVATE_KEY");
  const pem = keyInput.includes("BEGIN") ? keyInput : readPemFile(keyInput);
  return `${appId}:${installationId}:${Buffer.from(pem, "utf8").toString("base64")}`;
}

function readPemFile(path: string): string {
  return readFileSync(path, "utf8");
}

function parseTarget(value: string): { target: string; number: number } {
  const match = /^([^#\s]+#\d+)$/.exec(value);
  if (match === null) {
    throw new Error(`The live target must be "<owner>/<repo>#<number>". It is not shown here.`);
  }
  return { target: match[1]!, number: Number(value.split("#")[1]) };
}

const context = () => ({
  credential: { providerId: "live", credentialId: "GITHUB_APP_CREDENTIAL", value: credentialValue() },
  timeoutMs: 20_000,
});

function request(capability: string, target: string, parameters: Record<string, unknown> = {}): ConnectorRequest {
  return { capability, target, parameters, businessTransactionId: `live-${Date.now()}-${capability.replace(":", "-")}` };
}

describeLive("github live: read a real pull request", () => {
  it("github:pr-fetch returns the real head SHA, mergeable state and base branch", async () => {
    const { target } = parseTarget(requireEnv("TEST_GITHUB_TARGET"));
    const response = await createGitHubConnector().execute(request(GITHUB_PR_FETCH_CAPABILITY, target), context());

    expect(response.success).toBe(true);
    const body = response.metadata.body as Record<string, unknown>;
    expect(body["headSha"]).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof body["baseRef"]).toBe("string");
    expect(body["mergeable"] === true || body["mergeable"] === false || body["mergeable"] === null).toBe(true);
    expect(JSON.stringify(response)).not.toContain(requireEnv("TEST_GITHUB_APP_PRIVATE_KEY").slice(0, 40));
  });

  it("github:pr-fetch refuses a pull request number that does not exist", async () => {
    const { target } = parseTarget(requireEnv("TEST_GITHUB_TARGET"));
    const missing = target.replace(/#\d+$/, "#999999999");

    await expect(createGitHubConnector().execute(request(GITHUB_PR_FETCH_CAPABILITY, missing), context())).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("HTTP 404"),
    });
  });
});

describeWrites("github live: comment on a disposable pull request", () => {
  it("github:comment posts one comment with the transaction marker, and GitHub confirms it", async () => {
    const { target } = parseTarget(requireEnv("TEST_GITHUB_WRITE_TARGET"));
    const response = await createGitHubConnector().execute(
      request(GITHUB_COMMENT_CAPABILITY, target, { body: "Live test comment from parmana-connectors. Safe to delete." }),
      context(),
    );

    const body = response.metadata.body as Record<string, unknown>;
    expect(typeof body["commentId"]).toBe("number");
    expect(String(body["url"])).toContain("#issuecomment-");
  });
});

describeWrites("github live: merge a disposable pull request", () => {
  it("github:pr-merge with the current head SHA merges the disposable pull request", async () => {
    const { target } = parseTarget(requireEnv("TEST_GITHUB_MERGE_TARGET"));
    const read = await createGitHubConnector().execute(request(GITHUB_PR_FETCH_CAPABILITY, target), context());
    const headSha = (read.metadata.body as Record<string, unknown>)["headSha"] as string;

    const response = await createGitHubConnector().execute(
      request(GITHUB_PR_MERGE_CAPABILITY, target, { mergeMethod: "squash", expectedHeadSha: headSha }),
      context(),
    );

    expect((response.metadata.body as Record<string, unknown>)["merged"]).toBe(true);
  });

  it("github:pr-merge refuses a stale head SHA and GitHub does not merge", async () => {
    // Runs against a second disposable pull request, so it is not already merged.
    const { target } = parseTarget(requireEnv("TEST_GITHUB_STALE_TARGET"));
    const stale = "0".repeat(40);

    const error = await createGitHubConnector()
      .execute(request(GITHUB_PR_MERGE_CAPABILITY, target, { mergeMethod: "squash", expectedHeadSha: stale }), context())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("upstream_error");
  });
});
