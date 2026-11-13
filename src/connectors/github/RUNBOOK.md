# GitHub connector runbook

This runbook covers running the `github` connector in production: the App, the service settings, the Parmana core registration, checks, rotation, stopping it, and what to do when a comment's outcome is unclear.

It builds on [RUNBOOK.md](../razorpay/RUNBOOK.md), which covers the Vercel project, the Supabase database and the deployment steps. Follow that runbook first. The differences for GitHub are below.

## Status before you start

Read this first. The connector is **not ready for production**, and this runbook assumes these gaps are closed first:

- **No live end-to-end run yet.** No signed release has been run through the deployed service to the live GitHub API. Run the test in [Step 7](#step-7-first-controlled-test) before anything else.
- **Recovery marker.** Each comment now ends with `<!-- parmana:btx=<businessTransactionId> -->`. This is present only from the release of the connector that includes it. Confirm it is deployed before production (see [Known gaps](#known-gaps)).
- **Policy and registration are in core.** The `github-pr-comment` policy and the `github:comment` registration are made in `parmana-core`, through maker-checker. Neither is live until that work merges.
- **Repeat risk is open.** The connectors README lists it as an open decision: a repeated release can post a second comment. The release ledger blocks a repeat of the same release. It does not stop a new, separately approved request from posting again.

## Capabilities and what they can do

| Capability | Effect | Enable in production? |
| --- | --- | --- |
| `github:comment` | Posts one comment, up to 4,000 characters | Yes, first. The lowest-risk action, and easy to delete |
| `github:pr-fetch` | Reads a pull request's state. Read only | After comments are proven |
| `github:pr-merge` | Merges a pull request | **Not until its own review.** A merge is hard to undo |

Register only the capabilities you have reviewed. Each one is registered separately in core, so enabling `github:comment` does not enable merges.

## Step 1: the GitHub App

1. Use one App for the whole project, owned by the account or organisation that owns the target repositories. Do not share its key outside the service.
2. Set the permissions to the least that the enabled capabilities need:

   | Permission | Level | Needed for |
   | --- | --- | --- |
   | Metadata | Read-only | Required by GitHub |
   | Pull requests | Read and write | `github:comment` and `github:pr-merge`. Read only for `github:pr-fetch` |
   | Contents | Read and write | `github:pr-merge` only |

   For a comment-only start, leave Contents at **No access**.
3. Install the App on the **selected repositories only**. Never choose **All repositories**.
4. Note the App ID and the installation ID (the number after `/installations/` in the install page's address).
5. Generate a private key. Store the downloaded file in your password manager. Never paste it into chat or commit it.

## Step 2: build the credential

The service reads one environment variable, `GITHUB_APP_CREDENTIAL`, in this form:

```
<app id>:<installation id>:<base64 of the PEM private key>
```

The key must be **base64-encoded**. The service decodes it and rejects a raw PEM, because a PEM's line breaks do not fit in an environment variable. To build it on Windows PowerShell, from the downloaded file:

```powershell
$pem = [System.IO.File]::ReadAllText("C:\path\to\the-app-key.pem")
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($pem))
"<app id>:<installation id>:$b64" | Set-Clipboard
```

Paste the clipboard into the Vercel prompt in Step 3. Do not write it to a file. Clear the clipboard afterwards.

Expected: the service accepts the value at startup. A raw PEM, or a value with the wrong number of `:` parts, is rejected with `credential_invalid`, and its value is not shown.

## Step 3: Vercel settings for GitHub

The GitHub connector runs in its **own** Vercel project, `<github-project>`, created in step 7 of [ROLLOUT.md](ROLLOUT.md). It must not reuse the Razorpay project, which runs one different connector. Replace `<github-project>` everywhere in this file with that project's name before you run a command.

These are the settings from [RUNBOOK.md, Step 5](../razorpay/RUNBOOK.md#step-5-set-the-vercel-environment-variables), with two changes:

```bash
vercel env add PARMANA_CONNECTOR production              # type: github
vercel env add GITHUB_APP_CREDENTIAL production          # type: the value built in Step 2 (Secret)
```

Keep `PARMANA_RELEASE_LEDGER=postgres` and `PARMANA_DATABASE_URL` set, as in the main runbook. Without a durable ledger, a restart could allow a release to run twice.

`PARMANA_ALLOW_LIVE_KEYS` concerns the payment connectors. It does not change how the GitHub connector runs.

Then redeploy `main`, as in the main runbook, and confirm the health check:

```bash
vercel curl https://<github-project>.vercel.app/api/health
```

Expected: a healthy response for `github`. If the service starts with a credential error, read the `reason` in `vercel logs` and fix the variable.

## Step 4: register the capability in core

This happens in `parmana-core`, not here. It has two parts, and the policy part must finish first.

### 4a. Approve the policy and log it

The `github-pr-comment` policy (`policies/github-pr-comment/1.0.0/policy.json` in `parmana-core`) must have an approval in production before the required `verify-policy-approvals` check on `main` will pass.

1. **Propose the policy** in the production maker-checker flow: `github-pr-comment` version `1.0.0`, with the content from the repository.
2. **Get a second approver.** A different person must approve it. The threat model notes that production currently has one person holding both roles, so confirm a second approver is possible before you start. Do not approve your own proposal.
3. **Export the approval to the log.** The operator runs this in a clone of `parmana-core` on an up-to-date `main`, with the read-only connection string (never the application's database URL):

   ```powershell
   git checkout main
   git pull
   git checkout -b policy-log-github-pr-comment
   npm ci
   npm run build
   $env:CI_DATABASE_URL = '<read-only connection string>'
   npm run policy-log:export -- --policy github-pr-comment
   npm run policy-log:verify
   ```

   The export appends the approval to `governance/policy-approvals.jsonl`. Expected: `The log verifies: the chain is intact and every signature checks out.`
4. **Add the log change to the policy PR.** Commit only the two governance files, then push to the PR's branch. The PR's `verify-policy-approvals` check should then pass.

Do not edit the log by hand, and do not paste `CI_DATABASE_URL` into chat or a commit. The full procedure is in [`governance/README.md`](https://github.com/pavancharak/parmana-core/blob/main/governance/README.md) in `parmana-core`.

### 4b. Register the capability

Only after 4a has merged:

1. A maker proposes `github:comment` with the endpoint `https://<github-project>.vercel.app/api/execute`, names the policy `github-pr-comment` at version `1.0.0`, and lists the allowed parameters: `body`.
2. A different person, the checker, approves it with a step-up signature.
3. Check `GET /external-connectors` shows the registration as active.

The maker cannot approve their own change. This is the same flow as the tutorial in `examples/tutorials/123-external-connector`.

### Current status

- Policy PR: [parmana-core#608](https://github.com/pavancharak/parmana-core/pull/608). It replaces the earlier draft #605. It has two approvals per comment, and its unit and verifier tests cover both. It fails `verify-policy-approvals` until 4a is done.
- Policy PR checks: the full build, typecheck and test suite have not yet been run on the branch.
- Policy approval in production: not yet proposed.
- Registration: not started.

## Step 5: how a comment is approved

The `github-pr-comment` policy allows a comment only with **two** signed approvals from trusted people:

1. a **target approval** for the exact pull request (`owner/repo#number`), and
2. a **body approval** for the exact comment text.

Changing one word of the text needs a new body approval. A target approval for one pull request cannot be used on another.

A person approves in the Parmana approval flow. Do not approve a comment you have not read in full.

## Step 6: checks before going live

Confirm each of these on the test repository before any real one:

- A comment on a test PR appears once, from the App's name (not your own account).
- A repeat of the same release is refused by the ledger and posts nothing.
- A comment for a PR outside the installation is refused, and nothing is posted.
- A comment over 4,000 characters is refused before any call.
- Revoking the registration in core stops the next request with `CONNECTOR_NOT_REGISTERED`.

## Step 7: first controlled test

1. Pick a test PR in a test repository that the App is installed on.
2. Approve one short comment through the flow in Step 5.
3. Check the PR. Expected: one comment, from the App.
4. Check the logs: `vercel logs <github-project>.vercel.app --json`. Expected: one `release_answered` line with `success: true`.
5. Delete the test comment on GitHub, once you have checked it.

Do not move past this step until it passes.

## Checking health and activity

- Health: `vercel curl https://<github-project>.vercel.app/api/health`.
- Activity: `vercel logs <github-project>.vercel.app --json`. Watch for `release_answered`, `release_refused` and `connector_failed`.
- On GitHub: the App's own activity, and the repository's audit log for comments.

## Errors you may see

| Message or code | Cause | What to do |
| --- | --- | --- |
| `credential_invalid`, "The GitHub App private key is not a PEM private key" | `GITHUB_APP_CREDENTIAL` holds a raw PEM, not base64 | Rebuild the value (Step 2) and redeploy |
| `credential_invalid`, "must be numbers" | App ID or installation ID is not numeric | Check both IDs against the App page and the install URL |
| `credential_invalid`, "GitHub refused the App token request (HTTP 401)" | The key does not match the App ID, or the key was deleted on GitHub | Check the App ID and rotate the key (below) |
| `upstream_error`, "GitHub did not post the comment (HTTP 403)" | The App lacks Pull requests write, or is not installed on the repository | Fix the permission or the installation, then retry with a **new** approval |
| `upstream_error`, "GitHub did not post the comment (HTTP 404)" | The PR number is wrong, or the repository is not in the installation | Check the target and the installation's repositories |
| `invalid_input`, "body must be a non-empty string" | The comment is empty or over 4,000 characters | Shorten it, and request a new approval |
| `unknown_capability` | The connector does not run that capability | Check the registration in core |
| `CONNECTOR_NOT_REGISTERED` | The registration is revoked or was never approved | Register it through maker-checker, or leave it stopped |

## If the outcome is unclear

Use this when the service answered `upstream_error` with "The comment may have reached GitHub", or a release was recorded and no answer reached you.

1. **Do not resend.** The ledger refuses a repeat of the same release. A new approval posts a new comment, so only send one after you have checked step 2.
2. **Find the transaction ID** in the logs (`connector_failed` or `release_answered`).
3. **Check the ledger (read only)** in the `parmana-connectors` Supabase project, with the query from [RUNBOOK.md, Recovering a release](../razorpay/RUNBOOK.md#recovering-a-release-that-was-recorded-but-not-confirmed). Do not use the `parmana-sandbox` project.
4. **Check GitHub for the comment.** Search the PR's comments for the text `parmana:btx=<businessTransactionId>`. A comment that contains it was posted for that release. If none does, the comment was not posted for this release, as far as GitHub shows.
5. **Decide and record it.** If the comment exists, record it and do not repeat it. If it does not exist, tell the owner. Do not raise a new approval until the owner agrees.

## Rotating the App key

1. On the App page, generate a **new** private key. Keep the old one for now.
2. Build the new `GITHUB_APP_CREDENTIAL` value (Step 2) with the new key.
3. Set it in Vercel (`vercel env rm GITHUB_APP_CREDENTIAL production`, then `vercel env add` again), and redeploy `main`.
4. Run the check in Step 7.
5. Delete the old key on the App page.

Rotate at once if a key may have been exposed. Step 6 then becomes a new check on the test repository.

## Stopping the connector

Use the quickest step that fits:

1. **Stop one capability:** revoke its registration in core, through maker-checker. The next request is refused with `CONNECTOR_NOT_REGISTERED`.
2. **Stop the whole connector at once:** uninstall the App from the repository, or remove `GITHUB_APP_CREDENTIAL` in Vercel and redeploy. With the credential removed the service refuses to start, which is the intended fail-closed behaviour.

Stopping does not undo comments already posted. Remove those by hand on GitHub.

## Known gaps

These need code or core changes before production. They are not steps you can do with this runbook.

1. ~~Transaction marker in comments.~~ Added: each comment ends with `<!-- parmana:btx=<id> -->`. Check it is in the deployed release before production.
2. **Repeat risk.** Decide whether a second, separately approved comment with the same text is allowed. Open in the connectors README.
3. **Merge safety.** `github:pr-merge` needs its own review before it is enabled.
4. **No live run yet.** See [Step 7](#step-7-first-controlled-test).
