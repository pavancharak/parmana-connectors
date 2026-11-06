# Slack connector

A connector that posts one message to one Slack channel, only when a trusted person has signed an approval for that channel. Parmana records each decision in a signed trust record that anyone can verify offline.

> **Status:** Pre-production. The request shape has not been checked against a live Slack workspace. See [Known limits](#known-limits).

## Capability

| Capability | Policy | What it does |
|---|---|---|
| `slack:post-message` | `slack-post-message` 1.1.0 | Posts one message with `chat.postMessage` to the channel the release authorised. |

- `channel` must be a non-empty string, and it must equal the release's target. A release cannot post to a channel other than the one it was approved for.
- `text` must be a non-empty string.
- Only `channel` and `text` are sent. Any other parameter is refused before a call.

A post is refused unless:

- A signed approval exists for that channel (`postApproved`).
- The content and channel checks the caller declares are true. These can refuse a post, but they cannot authorize one on their own.

## Architecture

```
Agent ──request──► Parmana core (policy, approval, signed decision)
                        │
                        │ signed release (approved action only)
                        ▼
                   parmana-connectors (this connector)
                        │ bot token, bearer header (never stored)
                        ▼
                   Slack API (https://slack.com/api/chat.postMessage)
```

- **Code:** `slack-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Tests:** `tests/connectors/slack/`. They use a fake Slack and do not contact Slack.

## Requirements

- Node.js 24 or later
- A Slack app installed in a test workspace, with a bot token that has the `chat:write` scope
- The bot must be a member of the target channel
- Parmana's Ed25519 public key for verifying releases

## Credential

`SLACK_BOT_TOKEN` holds a bot token that starts with `xoxb-`. It must not be empty and must not contain spaces. It is sent only as a bearer header. Errors and results show only a fingerprint of it.

Use a test workspace until live use is approved.

## Success and failure

Slack returns HTTP 200 even when it refuses a message, so the connector reads the `ok` field in the JSON body:

- `ok: true` is success.
- `ok: false` is a refusal. The error includes Slack's error code if it is a short lowercase word, such as `channel_not_found`. Anything else is not shown.
- A missing or non-boolean `ok` field fails closed.

## Configuration

Copy `.env.example` to `.env` for local runs. On a hosted service, set these in the host's environment instead.

| Variable | Value | Notes |
|---|---|---|
| `PARMANA_CONNECTOR` | `slack` | One connector per running service |
| `SLACK_BOT_TOKEN` | `xoxb-...` | Secret. Test workspace only until live use is approved. |
| `PARMANA_PUBLIC_KEY` or `PARMANA_PUBLIC_KEY_FILE` | Ed25519 public key | Set one, never both |
| `PARMANA_RELEASE_AUDIENCE` | The endpoint URL, exactly as registered in `parmana-core` | Must be `https` |
| `PARMANA_NONCE_STORE` | `postgres` | Required for more than one instance |
| `PARMANA_DATABASE_URL` | Postgres connection string | Secret |
| `PARMANA_ALLOW_LIVE_KEYS` | `false` | Keep `false` until live use is approved |
| `PARMANA_CONNECTOR_TIMEOUT_MS` | `10000` | Default |

## Running

Locally:

```bash
npm ci
npm test
npm start
```

Hosted: set the variables above in the host's environment and deploy. Environment changes apply to new deployments only, so redeploy after every change. Do not deploy a `.env` file.

## Test run

1. Create a test channel in a test workspace and invite the bot.
2. Post one message with a signed `slack-post-message` approval for that channel.
3. Confirm the message appears in the channel.
4. Try a second release naming a different channel. It should be refused.
5. Verify the trust records with `parmana-verifier`.

## Policies

- `slack-post-message` 1.1.0 allows a post only with `postApproved: true` for the channel. The `channelId` is bound to the target. `contentApproved` and `channelAuthorized` are declared by the caller, so they can refuse a post but cannot authorize one.
- The connector also checks the channel against the release target. Both checks must pass.

Confirm that the policy version is in effect on your instance before you test. See the `/policies/in-effect` endpoint in the API docs.

## Security model

- **Credential isolation.** The bot token is never returned to the caller, the decision or the evidence.
- **Channel binding.** A release can post only to its own target channel.
- **Fail closed.** A malformed token, an unknown parameter, an empty message or a missing `ok` field is refused.
- **Replay protection.** Releases are single-use, enforced through the nonce store.

## Known limits

- **Repeats are not detected.** Slack gives no receipt for a message, so the connector cannot tell whether a message was already posted. A repeated release posts again. This needs a decision before Slack is made live, for example a check of recent channel history.
- **Not yet verified live:** the request shape has not been checked against a live Slack workspace.
- **Ambiguous outcomes:** if a message may have reached Slack but no answer was read, the error tells the operator to check the channel before any other action.
- **Caller-declared checks:** `contentApproved` and `channelAuthorized` come from the caller. Have the caller check the content before declaring it.

## Operations

- **Rotate the token:** reinstall the Slack app or regenerate its bot token, update `SLACK_BOT_TOKEN`, redeploy, then revoke the old token.
- **Revoke access:** remove the app from the workspace. This stops all calls immediately.
- **Monitor:** review every `upstream_error` that says to check the channel.

## Contributing and security

Read `CONTRIBUTING.md` before you open a pull request. Report vulnerabilities privately, as described in `SECURITY.md`. Do not open a public issue for them.
