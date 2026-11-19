# Razorpay in Parmana

A working book about how Razorpay is connected to Parmana: what was built, what was removed, what is in review, and how to run, check, and troubleshoot each part.

**Status as of 2026-11-08.** Read this first.

- **Removed from `parmana-core`.** The Razorpay refund demo and its database tables were removed from core on 2026-08-12 and 2026-09-16.
- **Lives in `parmana-connectors`.** The current `razorpay:refund` connector is in that repository, at `src/connectors/razorpay/`. It was built and tested against a fake Razorpay, and run in Razorpay's test mode on 29 October 2026 (4 of 4 checks passed). It has not been run with live keys.
- **In review in `parmana-core`.** A read-only Razorpay payment signal source and draft refund policies are on the branch `feat/razorpay-payment-signal`, in pull request #512. It is not merged, and its required checks are failing.
- **Never live.** No Razorpay refund in these repositories has moved live money. The connector refuses `rzp_live_` keys unless `PARMANA_ALLOW_LIVE_KEYS=true`.

For the current connector in detail, read `repos-and-razorpay.md`, section 3. Chapters 5, 9 and 10 below describe the removed demo, and point to the current material where it applies.

Facts in this book come from the repository at the commits and files named in each chapter. Where a statement is general Razorpay knowledge rather than something checked in this repository, the chapter says so.

---

## Contents

1. Orientation
2. Timeline
3. Concepts
4. Architecture
5. The refund connector, step by step
6. The payment signal source, step by step
7. Policies and the daily refund limit
8. Database tables
9. Setup and commands
10. Troubleshooting
11. Tests and continuous integration
12. Security and limits
13. Where to find each file
14. What this book does not cover

---

## 1. Orientation

Parmana decides whether an AI agent's action may happen. It releases an action only when a policy approves it, and each decision is recorded in a signed record. A connector is the part that carries out an approved action in an outside system. Razorpay is one such outside system: it holds payments, and a refund moves money back to the payer.

Parmana never holds a Razorpay credential in the decision path. The connector holds it, and it acts only on a release that Parmana has signed.

## 2. Timeline

| Date       | Event                                                                                                                                                                        | Where to read it                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-18 | Razorpay webhook tables added (signature-verified event receipt and an audit trail)                                                                                          | [`supabase/migrations/20260718182238_add_razorpay_webhook_tables.sql`](https://github.com/pavancharak/parmana-core/blob/main/supabase/migrations/20260718182238_add_razorpay_webhook_tables.sql)                       |
| 2026-08-05 | Daily cumulative refund reservation ledger added                                                                                                                             | [`supabase/migrations/20260805170000_add_razorpay_daily_refund_reservations.sql`](https://github.com/pavancharak/parmana-core/blob/main/supabase/migrations/20260805170000_add_razorpay_daily_refund_reservations.sql) |
| 2026-08-12 | Razorpay demo connector and its payment capability removed from `parmana-core`                                                                                               | Migration header for the table drop; verification gap G-27                                                                                                                                                             |
| 2026-11-03 | Connector migration out of `parmana-core` (ADR-0018). The Razorpay connector, with Paytm, Slack, GitHub, HubSpot and Zoho, is in `parmana-connectors`. Zerodha is paper only | `parmana-connectors` README, "Migration out of parmana-core" status row; ADR-0018                                                                                                                                      |
| 2026-09-16 | Three orphaned Razorpay tables dropped; seven historical audit rows backed up outside the repository                                                                         | [`supabase/migrations/20260916120000_drop_razorpay_tables.sql`](https://github.com/pavancharak/parmana-core/blob/main/supabase/migrations/20260916120000_drop_razorpay_tables.sql)                                     |
| 2026-11-04 | Remaining connector-only examples removed or renamed                                                                                                                         | Commit `5aeae62`                                                                                                                                                                                                       |
| 2026-11-08 | Draft policies and the read-only payment signal source added on the feature branch                                                                                           | Pull request #512; commits `589bbaf`, `b47b851`, `99285b7`, `36fe631`                                                                                                                                                  |

Before the removal there were many Razorpay pull requests, from #59 (the refund agent) through #175 (the status runbook). Examples include #59, #135 (Windows setup script), and #175. This book does not summarise each one.

## 3. Concepts

**Parmana terms used in this book**

- **Policy.** A versioned set of rules. A policy names the capabilities it allows and the facts (signals) it needs before it approves.
- **Capability.** A named action, for example `razorpay:refund`.
- **Signal.** A fact a policy checks. A signal can be declared by the caller, approved by a human, or established by an independent source. Only the last two are trusted for money movement.
- **Approval.** A human's signature, made through the approval flow, that covers one action on one target for a stated amount.
- **Release.** Parmana's signed instruction that tells a connector to act.
- **Trust record.** The signed record of a decision and what happened afterwards.

**Razorpay terms used in this book** (general knowledge, not checked against the repository)

- **Payment id.** Starts with `pay_`, followed by letters and digits.
- **Paise.** The smallest unit of rupee. `100` paise is ₹1. The amounts in this codebase are in paise.
- **Test mode and live mode.** Test-mode keys start with `rzp_test_`. Live keys start with `rzp_live_`. Test mode moves no real money.
- **Refund.** A reversal of part or all of a captured payment. A payment can be refunded in several parts, up to its captured amount.
- **Receipt.** A merchant-supplied reference attached to a refund. This codebase uses Parmana's `businessTransactionId` as the receipt, so a retry can find the refund it already made.
- **Authentication.** Razorpay's API uses HTTP basic auth with the key id as the user name and the key secret as the password.

## 4. Architecture

```
Agent ──request──▶ Parmana core ──decision & signed release──▶ Connector service (parmana-connectors) ──▶ Razorpay (test mode)
                      ▲                                                  │
                      └──────────── connector's answer, recorded ─────────┘

Policy needs "payment.refundable"  ──▶ Razorpay payment signal source (read-only) ──▶ Razorpay GET /v1/payments/{id}
```

- The **agent** holds no Razorpay key and no approval key. It checks its input, then asks Parmana.
- **Parmana** evaluates the policy. It releases the action only when the policy approves.
- The **refund endpoint** holds the test-mode keys. It acts only on a verified release.
- The **payment signal source** reads a payment's state from Razorpay. It is read-only and makes no refund.

## 5. The refund connector, step by step

**This chapter describes the removed demo.** It was in `parmana-core` at `examples/razorpay-refund/`, as it existed at commit `5aeae62^`, and was removed on 2026-08-12. Use it for history.

**The current connector is in `parmana-connectors`.** It works differently: it checks for an earlier refund by calling Razorpay's refund-list endpoint, not by a stored receipt table. For the current steps, the answer format, the error codes, and the test-mode run, read `repos-and-razorpay.md`, section 3.

1. **The agent asks for a refund.** The agent checks the payment id against `pay_` plus 6 to 40 letters or digits, and the amount against a positive whole number of paise. A bad input is refused before any call.
2. **Parmana evaluates the policy.** It refuses the request unless a manager's signed approval covers this payment and this amount.
3. **Parmana signs a release.** The release names `razorpay:refund`, the payment id as its target, the amount in paise, and the approvals used.
4. **The endpoint verifies the release.** It checks Parmana's signature, that the release names the endpoint's own URL as its audience, and that the capability is `razorpay:refund`. Any failure returns HTTP 401, and nothing is refunded.
5. **The endpoint checks whether the refund already exists.** It lists the payment's refunds. If one carries this release's `businessTransactionId` as its receipt, it returns that refund and does not create another.
6. **The endpoint creates the refund.** It calls Razorpay's refund endpoint with the same receipt and the amount in paise. Each Razorpay call has a 4-second timeout, so two calls fit inside the 10-second connector timeout Parmana registers.
7. **The answer is recorded.** The endpoint's answer returns to Parmana and is kept in the signed record as the endpoint's claim.

The endpoint refuses any key that does not start with `rzp_test_`, and it refuses to start with an empty secret.

**The four demo cases (from the removed README).** The demo ran these four requests, in order, and expected these results:

| #   | Request                                                                        | Expected result                                                                    |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | No manager approval                                                            | Refused by the policy. Razorpay is never called                                    |
| 2   | Approval for this payment and ₹1 (100 paise), within the agent's grant         | Approved. Refunded once in Razorpay. The record verifies offline                   |
| 3   | Approval for ₹8 (800 paise), but the agent's grant allows up to ₹5 (500 paise) | Refused with `NOT_AUTHORIZED`. A manager's signature cannot lift the agent's limit |
| 4   | The approval from request 2, sent again                                        | Refused. An approval is used once                                                  |

**The demo's setup, in order (from the removed README, paraphrased).**

1. Build the endpoint with `build-endpoint.ts`, giving it Parmana's public key and the endpoint's own URL. Deploy it to Vercel. A release made for any other URL is refused, so the URL written into the build must be the deployed one.
2. Check the deployed endpoint refuses an empty request. It should answer with an error saying the body is not a `{ release, signature }` pair.
3. Propose the policy `razorpay-refund` 1.0.0 with the governance script, then have a checker approve it.
4. Propose the capability `razorpay:refund`, bound to the endpoint URL and the policy, with `amount` as its allowed parameter. A checker approves it.
5. Generate an agent key that may use only `razorpay:refund`. Store it in a password manager. Deploy the updated key list to Parmana's API.
6. Propose and approve a grant for the agent: up to 500 paise per refund, valid for seven days.
7. Run the four demo cases above.

The README's notes on approval keys, step-up keys, and where each key is stored are operational details. Keep them in the password manager and the runbooks, not in this book.

## 6. The payment signal source, step by step

This source is on `feat/razorpay-payment-signal` in `packages/runtime/src/business-validation/razorpay-payment-source.ts`. It establishes the fact `payment.refundable`.

1. **A policy asks for the fact** about a payment id, with the refund amount as a parameter. The source receives only the parameters the policy declares, not the whole request. This follows `main`'s rule that a source sees only the parameters its policy lists (commit `b47b851`).
2. **The subject is checked.** If it is not a `pay_` id, the answer is "not found". The source makes no call.
3. **The amount is checked.** It must be a positive whole number of paise, or the source throws.
4. **The source reads the payment.** It sends `GET /v1/payments/{id}` with basic auth, a 10-second timeout, and redirects set to error. The credential is never included in an error message.
5. **The answer is computed.** `holds` is true only when the payment's status is `captured`, its refund status is not `full`, and the amount minus the amount already refunded is at least the requested amount.
6. **The answer is time-limited.** It is valid for 60 seconds, the release lifetime. After that, a stale answer cannot be used.
7. **Failures are explicit.** HTTP 404 gives "not found". Any other non-200 status, a non-JSON body, or missing fields throws. The runtime records the source as unavailable.

The source is not yet registered. Its credential, and the policy that requires it, come in later steps.

## 7. Policies and the daily refund limit

**The demo policy `razorpay-refund` 1.0.0.** The original demo policy lived in `examples/razorpay-refund/policy.json` and was removed with the connector. A version of it was re-drafted on 2026-11-08 on the feature branch, as `policies/razorpay-refund/1.0.0/policy.json`. That draft is not active. It cannot become active until a listed checker approves it through policy governance.

**The draft `razorpay-refund` 1.1.0.** The feature branch adds `policies/razorpay-refund/1.1.0/policy.json` (commit `36fe631`). Its description says it replaces the demo 1.0.0 once approved. The policy's content, rule by rule:

- **Policy identity.** `policyId` `razorpay-refund`, `policyVersion` `1.1.0`, `schemaVersion` `1.0.0`.
- **Signals it declares.** `paymentRefundable` (boolean) and `managerApproved` (boolean). The caller cannot declare either one as trusted.
- **Signal source for `paymentRefundable`.** The `razorpay` source establishes the claim `payment.refundable`, for the subject `target` (the payment id). Its answer is valid for 60 seconds (`maxAgeSeconds: 60`). The source receives only the `amount` parameter.
- **Approval for `managerApproved`.** A signed approval whose resource id is `target` (the payment) and whose value is `parameters.amount`.
- **Rule `approve-razorpay-refund`.** Approves when `paymentRefundable` equals `true` and `managerApproved` is true.
- **Rule `reject-not-refundable`.** Rejects when `paymentRefundable` equals `false`, with the reason that Razorpay does not show the payment as refundable for this amount.
- **Rule `reject-default`.** Rejects anything else, with the reason that a required condition was not met.

The 1.0.0 demo differed in one key way: it required an authority grant (`requireAuthorityGrant`) for the agent, and a signed approval, but no signal source. Grant limits in that demo were checked per request, not as a running total. That matches the open gap G-93 (grant limits are per request), which is still open.

This chapter does not reproduce the whole JSON. Read the file directly for exact wording.

**The daily refund limit.** The original 1.0.0 demo capped the daily total of refunds. Before a database-backed counter existed, that total came from a caller-declared value, so a caller could declare any total it liked. The 2026-08-05 migration added an atomic per-day counter, `razorpay_daily_refund_reservations`, to close that gap (Phase 3B). It stored one running total per UTC day and nothing about individual refunds. The counter is gone now, because the table was dropped. The daily limit is therefore not enforced by any current code. The open work is recorded in [`docs/internal/VERIFICATION-GAPS.md`](https://github.com/pavancharak/parmana-core/blob/main/docs/internal/VERIFICATION-GAPS.md) (search for "daily") and [`docs/internal/OPEN-ITEMS.md`](https://github.com/pavancharak/parmana-core/blob/main/docs/internal/OPEN-ITEMS.md). I did not confirm a single gap ID for this item, so search for it rather than relying on one.

## 8. Database tables

| Table                                | Created    | Purpose                                                                                                                                                                                 | Status                                                            |
| ------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `razorpay_webhook_events`            | 2026-07-18 | Records each webhook event once. The primary key on the event id makes a duplicate delivery fail at the database. Rows are written only after the webhook's HMAC signature is verified. | Dropped 2026-09-16 (zero rows)                                    |
| `razorpay_webhook_audit_events`      | 2026-07-18 | Audit trail for webhook receipt                                                                                                                                                         | Dropped 2026-09-16 (seven rows, backed up outside the repository) |
| `razorpay_daily_refund_reservations` | 2026-08-05 | One running total per UTC day                                                                                                                                                           | Dropped 2026-09-16 (zero rows)                                    |

The migration that dropped them states that no other table references them.

## 9. Setup and commands

**Current commands for the connector** are in `parmana-connectors`: the test-mode run ([`src/connectors/razorpay/test-run.mjs`](https://github.com/pavancharak/parmana-connectors/blob/main/src/connectors/razorpay/test-run.mjs)), the build, and the tests. Section 7 of `repos-and-razorpay.md` and the developer guide list them.

**The commands below are for the removed demo.** They come from `examples/razorpay-refund-agent/README.md` and the code. They use test mode only. They have not been run against a live account in this session.

**Set up Parmana's side first.** Create the policy, the capability, the grant, and the agent's key, as described in `examples/razorpay-refund/README.md`, steps 1 to 5. That README was removed with the connector, so use `git show 5aeae62^:examples/razorpay-refund/README.md` to read it.

**Send one refund request**

```bash
export PARMANA_ENDPOINT=https://parmana-api-real.vercel.app
export PARMANA_API_KEY=...   # the agent's key, from your password manager, never in chat
npx tsx examples/razorpay-refund-agent/send.ts --payment pay_XXXXXXXX --amount 100 \
  --approval-file approval.json --out record.json
```

Omit `--approval-file` to send a request with no approval. Parmana refuses it, and Razorpay is not called.

**Run the agent's tests**

```bash
npx vitest run examples/razorpay-refund-agent
```

**Check the signal source's tests (on the feature branch)**

```bash
git checkout feat/razorpay-payment-signal
npx vitest run packages/runtime/tests/unit/razorpay-payment-source.test.ts
```

**Run Prettier on the draft policy**

```bash
npx prettier --write policies/razorpay-refund/1.0.0/policy.json
npx prettier --check .
```

## 10. Troubleshooting

**Note.** This table covers the removed demo and the signal source. For the current connector, the error codes are `invalid_input`, `credential_invalid`, `unknown_capability`, `upstream_error` and `timeout`, with what to check for each. They are listed in `repos-and-razorpay.md`, section 3.6, and in `parmana-connectors`' [`src/connectors/razorpay/README.md`](https://github.com/pavancharak/parmana-connectors/blob/main/src/connectors/razorpay/README.md).

| Message or symptom                                                                         | Likely cause                                                                     | What to do                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "The payment must be a Razorpay payment id (pay_...)."                                     | The id does not match `pay_` plus 6 to 40 letters or digits                      | Copy the id from the Razorpay Test Mode dashboard                                                |
| "The amount must be a positive whole number of paise."                                     | Zero, negative, or fractional amount                                             | Use whole paise, for example `100` for ₹1                                                        |
| "This demo refunds only in Razorpay test mode: RAZORPAY_KEY_ID must start with rzp_test_." | A live key is configured                                                         | Use a `rzp_test_` key. Never put a live key in this demo                                         |
| "RAZORPAY_KEY_SECRET is not set."                                                          | The endpoint's secret is empty                                                   | Set it in the endpoint's environment, not in the agent                                           |
| Endpoint returns 401 with signature or audience errors                                     | The release is not signed by Parmana's key, or it names a different endpoint URL | Rebuild the endpoint with `build-endpoint.ts`, so the public key and URL match the deployment    |
| Endpoint returns 401 "this endpoint serves only razorpay:refund"                           | The release carries a different capability                                       | Check the capability name in the policy                                                          |
| Parmana refuses and Razorpay is not called                                                 | No valid manager approval for this payment and amount                            | Obtain a signed approval that names this payment and amount                                      |
| Refund reports `alreadyRefunded: true`                                                     | A refund with this receipt already exists                                        | Expected. The same release cannot refund twice                                                   |
| Signal source: "does not establish the claim"                                              | A policy asked for a fact this source does not provide                           | Check the claim name in the policy                                                               |
| Signal source: HTTP 404 or "not found"                                                     | The payment id is not in this Razorpay account, or the key is in the other mode  | Check the account and the mode of the key                                                        |
| Signal source: "answered HTTP 401" or another status                                       | The read credential is wrong or lacks access                                     | Check the key id and secret                                                                      |
| Signal source: timeout                                                                     | Razorpay did not answer within 10 seconds                                        | Retry. Until a read succeeds, the runtime records the source as unavailable                      |
| PR #512: `build-and-test` fails at Prettier                                                | `policies/razorpay-refund/1.0.0/policy.json` is not formatted                    | Run the Prettier commands in section 9                                                           |
| PR #512: `verify-policy-approvals` fails                                                   | The draft policy has no approved content hash                                    | Formatting will not fix this. Approve the policy through maker-checker, or remove it from the PR |

## 11. Tests and continuous integration

- The **refund agent** has tests in `examples/razorpay-refund-agent/tests/agent.test.ts`. They use a fake Parmana client.
- The **refund endpoint** had tests in `examples/razorpay-refund/tests/razorpay-refund.test.ts` before its removal.
- The **signal source** has tests in `packages/runtime/tests/unit/razorpay-payment-source.test.ts` on the feature branch.
- **Pull request #512** fails two required checks, as described in section 10. Its other checks pass, including DCO, CodeQL, and the SDK jobs.

## 12. Security and limits

- **Test mode only.** The removed demo endpoint refused live keys. The current connector refuses `rzp_live_` keys unless `PARMANA_ALLOW_LIVE_KEYS=true`. Nothing in these repositories has moved live money.
- **No secrets in this book or the repository.** Keys are set as environment variables on the endpoint, or in a password manager for the agent. They are never written into a file or pasted into a chat.
- **Approval is what releases money.** A refund needs a signed human approval for the payment and amount. The agent cannot approve its own request.
- **The daily limit is not enforced now** (section 7).
- **The payment signal source is read-only.** It cannot refund anything.
- **Caller-declared facts are not trusted for money.** The draft 1.1.0 policy requires `payment.refundable` from Razorpay, and a human approval.
- **Open verification gaps.** See [`docs/internal/VERIFICATION-GAPS.md`](https://github.com/pavancharak/parmana-core/blob/main/docs/internal/VERIFICATION-GAPS.md), especially G-27 (the removed capability). The daily-limit gap has no ID confirmed here. Search `VERIFICATION-GAPS.md` for "daily". The grant-limit and approval-fatigue gaps also apply to any future refund flow.

## 13. Where to find each file

| What                                   | Where                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Removed refund endpoint and client     | `git show 5aeae62^:examples/razorpay-refund/`                                                                                                                                                                                                                                      |
| Refund agent (current examples)        | `examples/razorpay-refund-agent/` on `5aeae62^`                                                                                                                                                                                                                                    |
| Agent Studio MCP server                | `examples/razorpay-agent-studio/` on commit `1acbb5a`                                                                                                                                                                                                                              |
| Payment signal source (feature branch) | `packages/runtime/src/business-validation/razorpay-payment-source.ts`                                                                                                                                                                                                              |
| Signal source tests (feature branch)   | `packages/runtime/tests/unit/razorpay-payment-source.test.ts`                                                                                                                                                                                                                      |
| Draft policies (feature branch)        | `policies/razorpay-refund/1.0.0/` and `1.1.0/`                                                                                                                                                                                                                                     |
| Table drops and history                | [`supabase/migrations/20260916120000_drop_razorpay_tables.sql`](https://github.com/pavancharak/parmana-core/blob/main/supabase/migrations/20260916120000_drop_razorpay_tables.sql)                                                                                                 |
| Verification gaps                      | [`docs/internal/VERIFICATION-GAPS.md`](https://github.com/pavancharak/parmana-core/blob/main/docs/internal/VERIFICATION-GAPS.md)                                                                                                                                                   |
| Current Razorpay connector             | `parmana-connectors`: [`src/connectors/razorpay/razorpay-connector.ts`](https://github.com/pavancharak/parmana-connectors/blob/main/src/connectors/razorpay/razorpay-connector.ts), its README, and `test-run.mjs`                                                                 |
| Current connector tests                | `parmana-connectors`: [`tests/connectors/razorpay/razorpay-connector.test.ts`](https://github.com/pavancharak/parmana-connectors/blob/main/tests/connectors/razorpay/razorpay-connector.test.ts)                                                                                   |
| Connector setup and settings           | `parmana-connectors`: [`README.md`](https://github.com/pavancharak/parmana-core/blob/main/README.md), [`.env.example`](https://github.com/pavancharak/parmana-core/blob/main/.env.example), [`RUNBOOK.md`](https://github.com/pavancharak/parmana-connectors/blob/main/RUNBOOK.md) |
| Open items                             | [`docs/internal/OPEN-ITEMS.md`](https://github.com/pavancharak/parmana-core/blob/main/docs/internal/OPEN-ITEMS.md)                                                                                                                                                                 |

## 14. What this book does not cover

- **The Agent Studio MCP server** (`examples/razorpay-agent-studio/mcp.ts`). It was built, but this book has not read its code in detail.
- **The full content of the draft policies.** Read the JSON files directly.
- **Webhook handling in depth.** The webhook tables were dropped, and the handler's code was not reviewed for this book.
- **Live-mode operation.** Nothing in this repository runs live Razorpay refunds, and this book does not describe how that would be set up.
- **The status of the removed runbooks** ([`docs/internal/runbooks/`](https://github.com/pavancharak/parmana-core/tree/main/docs/internal/runbooks) at earlier commits). Their content is referenced here only by commit.

## See also (parmana-guide)

- [Integration](https://github.com/pavancharak/parmana-guide/blob/main/docs/05-integration.md)
- [Troubleshooting](https://github.com/pavancharak/parmana-guide/blob/main/docs/06-troubleshooting.md)
