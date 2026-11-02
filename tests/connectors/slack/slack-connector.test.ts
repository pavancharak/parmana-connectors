import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import { SLACK_POST_MESSAGE_CAPABILITY, createSlackConnector, parseSlackBotToken, slackTokenFingerprint } from "../../../src/connectors/slack/slack-connector.js";

const TOKEN = "slack-test-bot-token-not-real";
const CHANNEL = "C0123456789";

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** A fake Slack. `reply` is the JSON it answers with, `status` the HTTP status, `fail` makes the call throw. */
function fakeSlack(options: { reply?: unknown; status?: number; fail?: boolean; rawText?: string } = {}) {
  const sent: Sent[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (options.fail) throw new Error("socket reset");
    const text = options.rawText ?? JSON.stringify(options.reply ?? { ok: true, channel: CHANNEL, ts: "1700000000.000100" });
    return new Response(text, { status: options.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, sent };
}

function request(overrides: Partial<ConnectorRequest> = {}, parameters: Record<string, unknown> = {}): ConnectorRequest {
  return {
    capability: SLACK_POST_MESSAGE_CAPABILITY,
    parameters: { channel: CHANNEL, text: "Refund approved for ORD-7001", ...parameters },
    target: CHANNEL,
    businessTransactionId: "3b8f4c1e-2a7d-4e9b-9c6f-1d2e3f4a5b6c",
    ...overrides,
  };
}

function context(value: string = TOKEN): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "SLACK_BOT_TOKEN", value }, timeoutMs: 5_000 };
}

describe("slack connector: credential", () => {
  it("accepts a bot token", () => {
    expect(parseSlackBotToken(TOKEN)).toBe(TOKEN);
  });

  it("refuses an empty token or one with spaces, without showing it", () => {
    expect(() => parseSlackBotToken("")).toThrow(ConnectorError);
    try {
      parseSlackBotToken("xoxb-with space");
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).code).toBe("credential_invalid");
      expect((error as ConnectorError).message).not.toContain("xoxb-with");
    }
  });

  it("gives a fingerprint that is not a piece of the token", () => {
    const fingerprint = slackTokenFingerprint(TOKEN);
    expect(fingerprint).toMatch(/^fp_[0-9a-f]{12}$/);
    expect(TOKEN).not.toContain(fingerprint);
  });
});

describe("slack connector: request checks, before any call", () => {
  it("refuses another capability", async () => {
    const fake = fakeSlack();
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request({ capability: "slack:delete" }), context())).rejects.toMatchObject({ code: "unknown_capability" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a parameter that is not allowed", async () => {
    const fake = fakeSlack();
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request({}, { as_user: true }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a channel that is not the authorised target", async () => {
    const fake = fakeSlack();
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request({ target: "C9999999999" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a release with no target", async () => {
    const fake = fakeSlack();
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request({ target: undefined }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses an empty text", async () => {
    const fake = fakeSlack();
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request({}, { text: "" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });
});

describe("slack connector: posting", () => {
  it("posts the message to the authorised channel with the bearer token", async () => {
    const fake = fakeSlack();
    const response = await createSlackConnector({ fetch: fake.fetch }).execute(request(), context());

    expect(response.success).toBe(true);
    expect(response.metadata.body).toEqual({ channel: CHANNEL, ts: "1700000000.000100", tokenFingerprint: slackTokenFingerprint(TOKEN) });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(fake.sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(fake.sent[0]?.body).toEqual({ channel: CHANNEL, text: "Refund approved for ORD-7001" });
  });

  it("treats ok: false as a refusal, even though HTTP is 200", async () => {
    const fake = fakeSlack({ reply: { ok: false, error: "channel_not_found" } });
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request(), context())).rejects.toThrow(/channel_not_found/);
  });

  it("refuses a response without an ok field", async () => {
    const fake = fakeSlack({ reply: { channel: CHANNEL } });
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request(), context())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("refuses an HTTP error", async () => {
    const fake = fakeSlack({ status: 500, reply: { ok: true } });
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request(), context())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("refuses a body that is not JSON", async () => {
    const fake = fakeSlack({ rawText: "<html>oops</html>" });
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request(), context())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("tells the operator to check the channel when the request fails in transit", async () => {
    const fake = fakeSlack({ fail: true });
    await expect(createSlackConnector({ fetch: fake.fetch }).execute(request(), context())).rejects.toThrow(/Check the channel/);
  });

  it("does not show the token in any error", async () => {
    const fake = fakeSlack({ reply: { ok: false, error: "not_authed" } });
    try {
      await createSlackConnector({ fetch: fake.fetch }).execute(request(), context());
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(TOKEN);
    }
  });

  it("does not repeat an error code that is not a short Slack code", async () => {
    const fake = fakeSlack({ reply: { ok: false, error: "<script>token=xoxb-leak</script>" } });
    try {
      await createSlackConnector({ fetch: fake.fetch }).execute(request(), context());
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("xoxb-leak");
      expect(String((error as Error).message)).toContain("unknown_error");
    }
  });
});
