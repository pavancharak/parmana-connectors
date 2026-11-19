# The Parmana repositories, environment settings, and the Razorpay connector

Status as of 2026-11-08. This document replaces the earlier statement that the Razorpay connector was removed everywhere. It was removed from `parmana-core` only. It lives in `parmana-connectors`.

---

## 1. The repositories

| Repository           | Role                                                                                                                                                          | Razorpay                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parmana-core`       | Decides whether an action may run. Holds policies, approvals, governance, the SDKs, and signed records. It never holds a business system's credential.        | The refund connector was removed on 2026-08-12. The read-only payment signal source and draft policies are on `feat/razorpay-payment-signal` (PR #512). |
| `parmana-connectors` | Runs the code that performs approved actions in business systems, outside core (ADR-0018). Each deployment runs one connector, chosen by `PARMANA_CONNECTOR`. | The `razorpay:refund` connector lives in `src/connectors/razorpay/`.                                                                                    |
| `parmana-docs`       | The public documentation site.                                                                                                                                | Not checked for this document.                                                                                                                          |
| `parmana-site`       | The marketing website.                                                                                                                                        | None.                                                                                                                                                   |
| `pavancharak`        | A profile repository with a README and docs.                                                                                                                  | None.                                                                                                                                                   |

**How the two main repos fit together.** `parmana-core` decides and signs a release. `parmana-connectors` verifies the release, performs the action with its own credential, and returns the result. Core then records the result against the signed release.

## 2. Environment settings, by repository

### `parmana-core`

Documented in [`.env.example`](https://github.com/pavancharak/parmana-core/blob/main/.env.example), [`.env.test.example`](https://github.com/pavancharak/parmana-core/blob/main/.env.test.example), and [`docs/site/deployment/environment-variables.mdx`](https://github.com/pavancharak/parmana-core/blob/main/docs/site/deployment/environment-variables.mdx). Two groups are relevant here:

- **Alerts (added in PR #513).** `ALERT_WEBHOOK_URL` turns on alerts for decisions and kill switch trips. It must be `https://`. `ALERT_WEBHOOK_SECRET` signs each alert body.
- **Kill switch.** `KILL_SWITCH_ENABLED` and `KILL_SWITCH_RESET_NEEDS_SECOND_OPERATOR`.

The file [`.env.example`](https://github.com/pavancharak/parmana-core/blob/main/.env.example) also contains a comment that the built-in connectors were removed. That comment is correct for `parmana-core`.

### `parmana-connectors`

Documented in [`.env.example`](https://github.com/pavancharak/parmana-core/blob/main/.env.example) and in the README's "Running the service" table. The settings, and what each one does:

| Setting                                           | Required                     | Default     | Purpose                                                                                                          |
| ------------------------------------------------- | ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `PARMANA_CONNECTOR`                               | Yes                          | none        | The connector to run: `github`, `hubspot`, `paytm`, `razorpay`, `slack` or `zoho`                                |
| `RAZORPAY_KEY_PAIR`                               | Yes, for `razorpay`          | none        | `<key id>:<key secret>`. The key id starts with `rzp_test_` or `rzp_live_`                                       |
| `PARMANA_ALLOW_LIVE_KEYS`                         | No                           | `false`     | Accepts `rzp_live_` keys. Leave it `false` until a live test is approved                                         |
| `PARMANA_PUBLIC_KEY` or `PARMANA_PUBLIC_KEY_FILE` | One of the two               | none        | Parmana's Ed25519 public key. Releases are refused unless they verify against it                                 |
| `PARMANA_RELEASE_AUDIENCE`                        | Yes                          | none        | This service's URL, exactly as registered in `parmana-core`. Must be `https://`                                  |
| `PARMANA_RELEASE_LEDGER`                          | No                           | `postgres`  | `postgres` shares replay protection across instances. `memory` is for one instance and tests                     |
| `PARMANA_DATABASE_URL`                            | With `postgres`              | none        | The database for replay protection. The service creates its table on start                                       |
| `PARMANA_SERVICE_PORT`                            | No                           | `8080`      | Port to listen on                                                                                                |
| `PARMANA_SERVICE_HOST`                            | No                           | `127.0.0.1` | Address to bind. A hosted service needs `0.0.0.0`                                                                |
| `PARMANA_CONNECTOR_TIMEOUT_MS`                    | No                           | `10000`     | Time limit for a connector call, from 100 to 120000 ms. For Razorpay it covers all of a release's calls together |
| `RAZORPAY_TEST_PAYMENT_ID`                        | Only for the test-run script | none        | A captured test payment id                                                                                       |
| `RAZORPAY_TEST_AMOUNT`                            | Only for the test-run script | `100`       | Paise to refund in the test run                                                                                  |

The other connectors' settings (`PAYTM_MERCHANT_CREDENTIAL`, `GITHUB_APP_CREDENTIAL`, `HUBSPOT_PRIVATE_APP_TOKEN`, `SLACK_BOT_TOKEN`, `ZOHO_ACCESS_TOKEN`, `ZOHO_ORGANIZATION_ID`) are listed in the same file and README. They are outside this document.

**Rules for these settings.** The service refuses to start if a required setting is missing or unsafe, and the error names the setting, never its value. A hosted service takes its settings from the host's environment. A `.env` file is for local runs only, is git-ignored, and is never deployed.

## 3. The Razorpay connector, in detail

The connector is in [`src/connectors/razorpay/razorpay-connector.ts`](https://github.com/pavancharak/parmana-connectors/blob/main/src/connectors/razorpay/razorpay-connector.ts). Its tests are in [`tests/connectors/razorpay/razorpay-connector.test.ts`](https://github.com/pavancharak/parmana-connectors/blob/main/tests/connectors/razorpay/razorpay-connector.test.ts). It runs one capability: `razorpay:refund`.

### 3.1 What a release must contain

| Field                   | Value                                                      | How the connector checks it                                             |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `capability`            | `razorpay:refund`                                          | Any other value is refused as `unknown_capability`                      |
| `target`                | A payment id: `pay_` followed by 6 to 40 letters or digits | Anything else is refused as `invalid_input`                             |
| `parameters.amount`     | A positive whole number of paise. `100` is ₹1              | Zero, negative, fractional, or non-number is refused as `invalid_input` |
| `businessTransactionId` | Parmana's transaction id. It becomes the refund's receipt  | Empty is refused as `invalid_input`                                     |

The connector does not compare the amount with the payment's captured amount. Razorpay applies its own limits.

The connector does not check the length of the receipt. A very long `businessTransactionId` depends on Razorpay accepting it.

### 3.2 The credential

- The value is `<key id>:<key secret>`.
- The key id must start with `rzp_test_` or `rzp_live_`, followed by letters or digits. The secret must not be blank.
- `rzp_live_` keys are refused unless `PARMANA_ALLOW_LIVE_KEYS=true`. The check runs at startup and again on every call.
- The credential is sent as HTTP Basic authentication, and only to `https://api.razorpay.com`. Redirects are refused, so it cannot reach another host.
- A refused credential is reported without its value. The error names the expected format.

### 3.3 Steps for one release

1. **List earlier refunds.** The connector calls `GET /v1/payments/{pay_id}/refunds?count=100&skip=N`. It reads pages of 100 until it finds a match or reaches a short page. It reads at most 10 pages, which is 1,000 refunds.
2. **Repeat check.** If a listed refund has `receipt` equal to the `businessTransactionId`, the connector returns that refund with `alreadyRefunded: true`. It creates nothing.
3. **Create the refund.** Otherwise it calls `POST /v1/payments/{pay_id}/refund` with the body `{ amount, speed: "normal", receipt, notes: { parmanaBusinessTransactionId } }`. It returns the new refund with `alreadyRefunded: false`.
4. **Time limit.** `PARMANA_CONNECTOR_TIMEOUT_MS` (10 seconds by default) covers the whole release. Each call gets what is left of it, so the list and the refund together never run past the limit. No call is retried.

### 3.4 The answer

The service returns the answer as `result.body`:

```json
{
  "refundId": "rfnd_...",
  "paymentId": "pay_...",
  "amount": 100,
  "status": "processed",
  "receipt": "txn-...",
  "alreadyRefunded": false
}
```

- `status` is what Razorpay reports for the refund, such as `pending` or `processed`.
- `receipt` is `null` if Razorpay returned none.
- `alreadyRefunded` is `true` when an earlier refund already carried this `businessTransactionId`.
- The service's own answer status is always `200` for this connector.

### 3.5 Limits of the repeat check

- It reads at most 1,000 refunds on one payment. If the payment has more, the connector refuses with `upstream_error` and creates nothing, because it cannot rule out an earlier refund. Check Razorpay's dashboard in that case.
- An earlier refund is returned whatever its `status`. If an earlier attempt is in a failed state, the repeat returns that failed refund and does not try again. Read the `status` in the answer.
- A list answer without an `items` array is refused. It is never read as "no earlier refund".

### 3.6 Errors

The connector throws a `ConnectorError`. The service returns only its code, as `connector failed: <code>`.

| Code                                | When                                                                                                                       | What the operator checks              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `invalid_input`                     | The target, amount, or `businessTransactionId` is wrong. No call was made                                                  | The release as sent by `parmana-core` |
| `credential_invalid`                | The key pair is malformed, or a live key is used without `PARMANA_ALLOW_LIVE_KEYS=true`. No call was made                  | The host's setting                    |
| `unknown_capability`                | The capability is not `razorpay:refund`                                                                                    | The release's capability              |
| `upstream_error` (Razorpay refused) | Razorpay returned an error for the list or the refund. Its code and description are in the message, which the service logs | Razorpay's dashboard                  |
| `upstream_error` (not reached)      | The network call failed. The message says whether a refund may exist                                                       | The recovery steps in section 4       |
| `timeout`                           | A call ran out of the time limit                                                                                           | As above                              |

The message says what to check. **No refund was created** when the failure came from the list call, or the refund call never left the service. **A refund may exist** when the refund call was sent and no answer came back. The message then names the receipt, and the operator checks Razorpay for that receipt before doing anything else.

The service refuses to run the same release twice, because the replay record already exists. Resending is never a recovery step.

### 3.7 Test-mode run

[`src/connectors/razorpay/test-run.mjs`](https://github.com/pavancharak/parmana-connectors/blob/main/src/connectors/razorpay/test-run.mjs) runs the connector against Razorpay's test API from your own machine:

```bash
export RAZORPAY_KEY_PAIR="rzp_test_...:<secret>"
export RAZORPAY_TEST_PAYMENT_ID="pay_..."
npm ci && npm run build
node --env-file-if-exists=.env src/connectors/razorpay/test-run.mjs
```

It makes one refund of `RAZORPAY_TEST_AMOUNT` paise (100 by default). It checks that a repeat returns the same refund. It also checks two refusals: a target that is not a payment id, and a zero amount. It refuses any key that is not `rzp_test_`, and it never prints the key. Test-mode refunds move no money.

The repo's status notes record a run on 29 October 2026 that passed 4 of 4 checks. No live run is recorded.

### 3.8 Not covered yet

- A payment with more than 1,000 refunds is refused, not refunded. A person must check Razorpay.
- Live keys. Live money is off, and no live run is recorded.
- The paging parameters (`count`, `skip`) follow Razorpay's API reference. The test-mode run has not been repeated against them since they were written.

## 4. Operations: a release that was recorded but not confirmed

The service records a release before it runs the connector. A recorded release cannot run again, so resending it does nothing. Only Razorpay can say whether a refund exists.

**Rules**

- Do not resend the same release.
- Do not delete rows from `parmana_connectors_release_ledger` or its archive to make a release run again. That is an owner's decision.
- Do not paste keys, connection strings, or other secrets into chat.

**Steps** (from [`RUNBOOK.md`](https://github.com/pavancharak/parmana-connectors/blob/main/RUNBOOK.md), "Recovering a release that was recorded but not confirmed")

1. **Find the transaction id.** Search the runtime log for the `connector_failed` or `release_answered` line. It shows the `businessTransactionId`, the error code, and the connector's message. Get the payment id from `parmana-core`'s record of the action. The log does not show it.
2. **Read the ledger.** In the Supabase project for `parmana-connectors`, run a read-only query for the transaction id. Do not use the sandbox project.
   - **No row:** the connector did not run for this release in this database. Confirm the release did not go to another database or environment before acting.
   - **A row with an answer:** the connector ran and the service stored its answer. Record the answer. Do not resend.
   - **A row with no answer:** the release was recorded, and the connector may have run, but the service stopped before storing the answer. A repeat gets HTTP 409 until an operator resolves it. Go to step 3.
3. **Check Razorpay** for a refund carrying that receipt, in the mode that matches the key.
4. **Record the decision** in the incident log, and only then take the next step the runbook gives.

## 5. Corrections to the earlier Razorpay book

- **Chapter 2 (Timeline).** Add: 2026-11-03, the connector migration out of `parmana-core` (ADR-0018) placed the Razorpay connector in `parmana-connectors`. The README there says six connector folders are on `main`: Razorpay, Paytm, Slack, GitHub, HubSpot and Zoho. Zerodha is paper only.
- **Chapter 5 (The refund connector).** The steps I described are the removed `parmana-core` demo. The current connector is in `parmana-connectors`, and it behaves differently: it checks for an earlier refund through Razorpay's list endpoint, not a stored record. Section 3 above is the correct description. The demo's steps were correct for the demo.
- **Chapter 4 (Architecture).** The refund flow goes from `parmana-core` to the connector service in `parmana-connectors`. That service is deployed on Vercel at `POST /api/execute`, and runs locally at `POST /execute`. It is not the removed demo endpoint.
- **Chapter 9 (Setup and commands).** The test-mode run is in `parmana-connectors` (section 3.7 above).
- **Chapter 10 (Troubleshooting).** The error codes in section 3.6 replace the demo's messages.

Items not verified in this document: the status of Zoho and the other connectors, and the content of `parmana-docs`.

## See also (parmana-guide)

- [Repositories](https://github.com/pavancharak/parmana-guide/blob/main/docs/02-repositories.md)
- [Deploy connectors](https://github.com/pavancharak/parmana-guide/blob/main/docs/04-deploy-connectors.md)
