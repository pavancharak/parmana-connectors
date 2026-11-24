# GitHub connector: capabilities

This file records what each GitHub capability does, every check it makes, every GitHub call it sends, and the test that covers each one. The code is `src/connectors/github/github-connector.ts`. The tests are `tests/connectors/github/`. The README covers setup and the App credential. This file covers the three capabilities.

## Policy for each capability

| Capability | Policy in effect (production) | Writes to GitHub | Status |
| --- | --- | --- | --- |
| `github:pr-fetch` | `github-pr-read` 1.1.0 | No | Connector and tests complete |
| `github:pr-merge` | `github-pr-approval` 1.1.0 | Yes, merges the pull request | Connector and tests complete |
| `github:comment` | `github-pr-comment` | Yes, posts a comment | Policy not yet defined. The connector and tests are complete, but no policy binds this capability in production |

A capability with no bound policy is refused by the server before the connector runs. This connector is not reached for it.

## Target

Every capability takes a target of the form `<owner>/<repo>#<pull number>`, for example `acme/payments#17`.

- `owner`: letters, digits and hyphens, 1 to 39 characters.
- `repo`: letters, digits, dots, underscores and hyphens, 1 to 100 characters. `.` and `..` are refused.
- `pull number`: digits, 1 to 10 characters.

Any other target is refused with `invalid_input` before any call is made. A missing target is refused the same way.

## Credential

The credential value is `<app id>:<installation id>:<base64 of the App's PEM private key>`. Every call does this, in order:

1. Parses the credential. A value with the wrong number of parts, a non-numeric App or installation id, or a key that is not a PEM private key is refused with `credential_invalid`. The error never shows any part of the value.
2. Signs a JWT with RS256, issued 60 seconds in the past and valid for 10 minutes, with the App id as issuer.
3. Calls `POST /app/installations/<installation id>/access_tokens` with that JWT. The installation token is used once and not stored.

Token failures:

| Situation | Error code | Message |
| --- | --- | --- |
| GitHub answers with a non-2xx status | `credential_invalid` | Names the HTTP status. Says the key or installation may be wrong. |
| The answer has no `token` | `credential_invalid` | "GitHub returned no installation token." |
| The request fails in transit or times out | `timeout` | Says nothing was sent to the pull request. |

In all three cases no call to the pull request is made.

## `github:pr-fetch`: read a pull request

**Parameters:** none. Any parameter is refused with `invalid_input`.

**GitHub calls:** one `GET /repos/<owner>/<repo>/pulls/<number>`, after the token request.

**Result** (`metadata.body`):

| Field | Source |
| --- | --- |
| `number` | `number` from GitHub, or `null` |
| `mergeable` | `mergeable` as a boolean, or `null` when GitHub has not computed it yet |
| `mergedAt` | `merged_at` as a string, or `null` |
| `headSha` | `head.sha` |
| `baseRef` | `base.ref`, or `null` |
| `tokenFingerprint` | A SHA-256 fingerprint of the installation token. Never the token. |

**Errors:**

| Situation | Error code |
| --- | --- |
| Parameter given | `invalid_input` |
| Target missing or malformed | `invalid_input` |
| Token refused | `credential_invalid` (see Credential) |
| GitHub answers with a non-2xx status, such as 404 for a pull request that does not exist | `upstream_error`, names the HTTP status |
| The answer has no `head.sha` | `upstream_error` |

A read never changes anything, so a failed read is safe to repeat.

## `github:pr-merge`: merge a pull request

**Parameters:**

| Name | Required | Rule |
| --- | --- | --- |
| `mergeMethod` | Yes | One of `merge`, `squash`, `rebase`. Anything else is refused with `invalid_input`. |
| `expectedHeadSha` | No | A 40 character lowercase hexadecimal commit SHA. Any other value is refused with `invalid_input`. |

Any other parameter is refused with `invalid_input`.

**GitHub calls:** one `PUT /repos/<owner>/<repo>/pulls/<number>/merge`, after the token request. The body is `{"merge_method": "<mergeMethod>"}`, plus `"sha": "<expectedHeadSha>"` when `expectedHeadSha` is given. Without it, GitHub merges whatever the head is at that moment.

**Result** (`metadata.body`): `merged` (always `true`), `sha` (the merge commit from GitHub, or `null` if GitHub does not name it), and `tokenFingerprint`.

**What the merge check does:** when `expectedHeadSha` is given, GitHub refuses the merge if the pull request head has moved since the decision was made. The connector does not compare the SHA itself; GitHub does, and the refusal arrives as an HTTP error.

**Errors:**

| Situation | Error code | Message |
| --- | --- | --- |
| Parameter invalid or not allowed | `invalid_input` | Before any call |
| Token refused | `credential_invalid` | Before any merge call |
| GitHub answers with a non-2xx status, including 405 (not mergeable) and 409 (the head moved, when `expectedHeadSha` was given) | `upstream_error` | Names the status. Says to check the pull request before any other action. |
| GitHub answers 2xx but `merged` is not `true` | `upstream_error` | "GitHub answered without confirming the merge." |
| The request fails in transit or the timeout passes | `upstream_error` | "The merge request may have reached GitHub, and no answer was read." Check the pull request before any other action. |

**Retries:** none. A merge is never retried by the connector. An unconfirmed merge needs a check on GitHub first.

## `github:comment`: post a comment

**Parameters:**

| Name | Required | Rule |
| --- | --- | --- |
| `body` | Yes | A non-empty string of at most 4,000 characters. |

Any other parameter is refused with `invalid_input`.

**Transaction marker:** the connector needs `businessTransactionId` to match `^[A-Za-z0-9._:-]{1,128}$`. It appends `<!-- parmana:btx=<id> -->` to the body, after a blank line, so an operator can find the comment later on GitHub.

**GitHub calls:** one `POST /repos/<owner>/<repo>/issues/<number>/comments`, after the token request. The body is `{"body": "<body>\n\n<!-- parmana:btx=<id> -->"}`.

**Result** (`metadata.body`): `commentId`, `url` (the comment's `html_url`, or `null`), and `tokenFingerprint`.

**Errors:**

| Situation | Error code | Message |
| --- | --- | --- |
| Body missing, empty or too long | `invalid_input` | Before any call |
| Transaction id missing or unsafe | `invalid_input` | Before any call |
| Parameter other than `body` | `invalid_input` | Before any call |
| Token refused | `credential_invalid` | Before the comment call |
| GitHub answers with a non-2xx status | `upstream_error` | Names the status. Says to check the pull request. |
| The answer has no numeric `id` | `upstream_error` | "GitHub answered without confirming the comment." |
| The request fails in transit or times out | `upstream_error` | "The comment may have reached GitHub, and no answer was read." |

**Retries:** none. A comment is posted once.

## Errors that apply to every capability

| Situation | Error code |
| --- | --- |
| Capability not run by this connector | `unknown_capability`, before any call |
| Credential malformed | `credential_invalid`, before any call |
| Unexpected exception inside the connector | `upstream_error`, with a message that tells the operator to check the pull request |

No error message shows the App key, the installation token, or the credential value. The tests check this.

## Test coverage

| Capability | Test file | What it covers |
| --- | --- | --- |
| `github:pr-fetch` | `github-capabilities.test.ts` | Mergeable null; merged pull request; parameters refused; missing target refused; 404 from GitHub; token refused, and no pull request call; token fingerprint, not the token |
| `github:pr-fetch` | `github-connector.test.ts` | The read and the token exchange; a pull request with no head SHA |
| `github:pr-merge` | `github-capabilities.test.ts` | Each merge method sent as given; `sha` sent only with `expectedHeadSha`; missing method; upper case SHA; other parameters; 409 when the head moved; merged false; merged true with no SHA; token refused, and no merge call; token not shown in errors |
| `github:pr-merge` | `github-connector.test.ts` | Merge with method and SHA; unconfirmed merge; merge that may have reached GitHub; 405 |
| `github:comment` | `github-comment.test.ts` | Posting; empty or oversized body; transaction marker; unsafe transaction id; other parameters; malformed target; unanswered and refused comments; reply without id; reply that is not JSON; timeout; token refused |
| `github:comment` | `github-capabilities.test.ts` | The posted body with its marker; missing body refused |
| All | `github-capabilities.test.ts` | Advertised capabilities; unknown capability refused; malformed credential refused |

The test count for this directory is 56.

## Not covered

- **Live GitHub.** Most tests use a fake GitHub. `tests/connectors/github/github-live.test.ts` runs the same capabilities against the real API, but only with `ALLOW_LIVE_GITHUB=1`. Setup is in [LIVE.md](LIVE.md). The last recorded run passed all five live tests, on 2026-11-24.
- **Policies.** The policy names in the table above come from the production configuration. The connector does not check them.
- **Concurrency.** Two merges of the same pull request are not coordinated by the connector. GitHub decides which one wins.
- **Rate limits.** A GitHub rate-limit answer is an HTTP error. It is reported as `upstream_error` with its status, and is not retried.
