# GitHub connector

A connector that lets an AI agent read and merge GitHub pull requests only when a trusted person has signed an approval for that exact pull request. Parmana records each decision in a signed trust record that anyone can verify offline.

> **Status:** Pre-production. The request shapes have not yet been checked against a live GitHub App in a production repository. See [Known limits](#known-limits).

## Capabilities

| Capability | Policy | What it does |
|---|---|---|
| `github:pr-fetch` | `github-pr-read` 1.1.0 | Reads mergeable state, merge time, head SHA and base branch. Read-only. |
| `github:pr-merge` | `github-pr-approval` 1.1.0 | Merges with `merge`, `squash` or `rebase`. Optionally refuses if the head SHA has moved. |
| `github:comment` | `github-pr-comment` (not yet defined) | Posts one comment with the `body` parameter, up to 4,000 characters. Not sent again if the first call's answer is lost. |

Targets use the form `owner/repo#number`.

- `mergeMethod` must be `merge`, `squash` or `rebase`.
- `expectedHeadSha`, if given, must be a 40-character lowercase SHA. GitHub refuses the merge if the head has moved since the decision was made.
- Only the parameters listed above are allowed for each capability. Any other is refused before a call.
- A repeated merge of a merged pull request fails at GitHub rather than merging twice. The connector does not check this before sending, so the error tells the operator to check the pull request.

A merge is refused unless:

- A signed approval exists for that pull request (`mergeApproved`).
- The caller reports that required reviews, status checks and branch protection are satisfied, and the risk score is 20 or lower.
- `expectedHeadSha`, if given, matches the current head.

## Architecture

```
Agent ──request──► Parmana core (policy, approval, signed decision)
                        │
                        │ signed release (approved action only)
                        ▼
                   parmana-connectors (this connector)
                        │ GitHub App installation token (used once, never stored)
                        ▼
                   GitHub API ──► pull request
```

- **Code:** `github-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Tests:** `tests/connectors/github/`. They use a fake GitHub server and a generated RSA key, and do not contact GitHub.

## Requirements

- Node.js 24 or later
- A GitHub App installed on the target repository only
- A PostgreSQL database for replay protection (`PARMANA_RELEASE_LEDGER=postgres`)
- Parmana's Ed25519 public key for verifying releases
- A target repository whose default branch has a required status check, and a ruleset or branch protection rule

## GitHub App setup

1. Create the App under your account or organisation settings.
2. Set these permissions:

   | Permission | Level | Needed for |
   |---|---|---|
   | Metadata | Read-only | Required by GitHub |
   | Pull requests | Read (fetch) or Read and write (merge) | Reading and merging |
   | Contents | Read and write | Merging only |
   | Issues | No access | Not used |

3. Turn off webhooks. The connector does not receive events.
4. Install the App on **one** repository.
5. Generate a private key and store it outside any repository.
6. Build the credential as `<app id>:<installation id>:<base64 of the PEM>`:

   ```bash
   base64 -w0 your-app-key.pem
   ```

Never commit the PEM, its base64 value or a `.env` file.

## Configuration

Copy `.env.example` to `.env` for local runs. On a hosted service, set these in the host's environment instead.

| Variable | Value | Notes |
|---|---|---|
| `PARMANA_CONNECTOR` | `github` | One connector per running service |
| `GITHUB_APP_CREDENTIAL` | `<app id>:<installation id>:<base64 PEM>` | Secret |
| `PARMANA_PUBLIC_KEY` or `PARMANA_PUBLIC_KEY_FILE` | Ed25519 public key | Set one, never both |
| `PARMANA_RELEASE_AUDIENCE` | The endpoint URL, exactly as registered in `parmana-core` | Must be `https` |
| `PARMANA_RELEASE_LEDGER` | `postgres` | Required for more than one instance |
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

1. Create a disposable repository.
2. Add a default-branch commit and a workflow that defines a status check.
3. Open a pull request from a test branch.
4. Set the ruleset to require the status check. Keep required approvals at 0 for an owner-run test, because an author cannot approve their own pull request.
5. Keep **Block force pushes** on. Turn off **Restrict updates** only if it blocks the merge in your test.
6. Run `github:pr-fetch` with a signed `github-pr-read` approval.
7. Run `github:pr-merge` with a signed `github-pr-approval` approval.
8. Verify the trust record with `parmana-verifier`.

## Policies

Policies are versioned in `parmana-core/policies/`:

- `github-pr-read/1.1.0`: allows a read only with `readApproved: true` and a signed approval for that pull request.
- `github-pr-approval/1.1.0`: allows a merge only with `mergeApproved: true`, a risk score of 20 or lower, and the caller's declared checks. The caller declares the review, status-check and branch-protection signals; they are not read from GitHub. The signed approval is what authorizes the merge.

Confirm that a policy is in effect on your instance before you test. See the `/policies/in-effect` endpoint in the API docs.

## Security model

- **Credential isolation.** The credential is never returned to the caller, the decision or the evidence.
- **Short-lived tokens.** Each call signs a 10-minute App JWT, exchanges it for an installation token, and uses that token once. The token is never stored. Errors and results show only a fingerprint.
- **Fail closed.** A malformed credential, an unknown parameter or an invalid target is refused before any call to GitHub.
- **Replay protection.** Releases are single-use, enforced through the nonce store.
- **Ambiguous outcomes.** If a merge may have reached GitHub but no answer was read, the error tells the operator to check the pull request before any other action.

## Known limits

- **G-128:** code on the same host can read connector credentials from the server's environment. Run the connector on a host you control and restrict access to its environment.
- **G-129:** agents that call GitHub directly, without going through Parmana, are not checked or recorded. Route every pull request action through the gateway.
- **Caller-declared checks:** the merge policy trusts the caller's declared review, status-check and branch-protection signals. The caller should read these from GitHub before declaring them.
- **Not yet verified live:** the request shapes have not been checked against a live GitHub App. Treat the first production run as a test.
- **Scope:** pull requests only. The connector does not label or comment on issues.

## Operations

For production steps, rotation, recovery and stopping the connector, see [RUNBOOK.md](RUNBOOK.md) in this folder.

- **Rotate the App key:** generate a new key in the App settings, update `GITHUB_APP_CREDENTIAL`, redeploy, then delete the old key.
- **Revoke access:** uninstall the App from the repository. This stops all calls immediately.
- **Monitor:** review every `upstream_error` that tells you to check the pull request.

## Contributing and security

Read `CONTRIBUTING.md` before you open a pull request. Report vulnerabilities privately, as described in `SECURITY.md`. Do not open a public issue for them.
