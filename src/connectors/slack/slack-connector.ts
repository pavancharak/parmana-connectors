import { createHash } from "node:crypto";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector-contract.js";

/**
 * A connector for Slack. It has the same shape as the generic connector, so
 * the execution service can run either one.
 *
 * It posts one message, with chat.postMessage, to the channel the release
 * authorised. The channel in the parameters must equal the release's target,
 * so a caller cannot name an allowed channel in the target and post somewhere
 * else. Only the `channel` and `text` parameters are sent. Any other parameter
 * is refused before a call.
 *
 * Slack answers HTTP 200 even when it refuses a message. Failure is signalled
 * only by `ok: false` in the JSON body, so this connector checks `ok` and
 * fails closed when it is missing or false.
 *
 * Slack has no receipt for a message, so this connector cannot tell whether a
 * message was already posted. A repeated release posts again. This is the same
 * as the in-core Slack connector, and it is recorded in the README as open.
 *
 * The credential is a bot token. Errors and results carry only a fingerprint of it.
 */

export const SLACK_POST_MESSAGE_CAPABILITY = "slack:post-message";

const API = "https://slack.com/api";
const POST_MESSAGE_PATH = "/chat.postMessage";
const DEFAULT_BUDGET_MS = 10_000;
const ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(["channel", "text"]);
/** Slack error codes are short lowercase words, such as "channel_not_found". Anything else is not shown. */
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;

export interface SlackConnectorOptions {
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

/** A fingerprint of the token, safe to show. Never a substring of the token. */
export function slackTokenFingerprint(token: string): string {
  return `fp_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12)}`;
}

/** Reads a bot token. Refuses an empty value or one with whitespace, without showing it. */
export function parseSlackBotToken(value: string): string {
  const token = value.trim();
  if (token === "" || /\s/.test(token)) {
    throw new ConnectorError("credential_invalid", "The Slack bot token is empty or contains spaces. Its value is not shown.");
  }
  return token;
}

function refuse(message: string): never {
  throw new ConnectorError("invalid_input", message);
}

export function createSlackConnector(options: SlackConnectorOptions = {}): GenericConnector {
  const doFetch = options.fetch ?? fetch;

  return {
    system: "slack",
    capabilities: [SLACK_POST_MESSAGE_CAPABILITY],

    async execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse> {
      if (request.capability !== SLACK_POST_MESSAGE_CAPABILITY) {
        throw new ConnectorError("unknown_capability", `The Slack connector does not run "${request.capability}".`);
      }

      for (const name of Object.keys(request.parameters)) {
        if (!ALLOWED_PARAMETERS.has(name)) {
          refuse(`Parameter "${name}" is not allowed for slack:post-message.`);
        }
      }

      const channel = request.parameters["channel"];
      if (typeof channel !== "string" || channel.trim() === "") {
        refuse("channel must be a non-empty string.");
      }
      // The policy binds the channel to the target. Posting elsewhere is refused.
      if (request.target === undefined || channel !== request.target) {
        refuse(`The channel "${channel}" is not the authorised target.`);
      }

      const text = request.parameters["text"];
      if (typeof text !== "string" || text === "") {
        refuse("text must be a non-empty string.");
      }

      const token = parseSlackBotToken(context.credential.value);
      const fingerprint = slackTokenFingerprint(token);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_BUDGET_MS);

      try {
        let response: Response;
        try {
          response = await doFetch(`${API}${POST_MESSAGE_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
            body: JSON.stringify({ channel, text }),
            signal: controller.signal,
          });
        } catch {
          // The message may have reached Slack before the failure, so the operator must check.
          throw new ConnectorError("upstream_error", "The message may have reached Slack, and no answer was read. Check the channel before any other action.");
        }

        if (!response.ok) {
          throw new ConnectorError("upstream_error", `Slack returned HTTP ${response.status}. Check the channel before any other action.`);
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new ConnectorError("upstream_error", "Slack returned a response that is not JSON. Check the channel before any other action.");
        }
        if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>)["ok"] !== "boolean") {
          throw new ConnectorError("upstream_error", "Slack returned a response without an ok field. Check the channel before any other action.");
        }

        const answer = body as Record<string, unknown>;
        if (answer["ok"] !== true) {
          const code = typeof answer["error"] === "string" && SLACK_ERROR_CODE.test(answer["error"]) ? answer["error"] : "unknown_error";
          throw new ConnectorError("upstream_error", `Slack refused the message (${code}).`);
        }

        return {
          success: true,
          metadata: {
            status: response.status,
            body: {
              channel: typeof answer["channel"] === "string" ? answer["channel"] : channel,
              ts: typeof answer["ts"] === "string" ? answer["ts"] : null,
              tokenFingerprint: fingerprint,
            },
          },
        };
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("upstream_error", "The Slack connector failed unexpectedly. Check the channel before any other action.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
