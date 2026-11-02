# Slack connector

`slack:post-message` posts one message, with `chat.postMessage`, to the channel the release authorised. It is the Slack connector moved from parmana-core under ADR-0018.

- **Code:** `slack-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Credential:** `SLACK_BOT_TOKEN`, a bot token (`xoxb-...`) with the `chat:write` scope. Errors and results show only a fingerprint of it.
- **Channel:** the `channel` parameter must equal the release's target. A release cannot post somewhere else.
- **Parameters:** only `channel` and `text` are sent. Any other parameter is refused before a call. `text` must not be empty.
- **Success:** Slack answers HTTP 200 even on refusal, so the connector checks `ok` in the JSON body and fails closed when it is missing or false.
- **Repeats (open):** Slack gives no receipt for a message, so this connector cannot tell whether a message was already posted. A repeated release posts again. The in-core Slack connector behaves the same way. This needs a decision before Slack is made live, for example a check of recent channel history.
- **Checks:** tests use a fake Slack, in `tests/connectors/slack/`. The request shape is the in-core connector's and has not been checked against a live Slack workspace.

If a request fails after the message may have been sent, the error says to check the channel before any other action.
