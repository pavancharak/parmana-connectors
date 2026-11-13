# GitHub connector: rollout plan

This file lists what must happen, in order, before the `github:comment` capability is used on real repositories. It is the plan. The current status and history are in [STATUS.md](STATUS.md). The step-by-step commands are in [RUNBOOK.md](RUNBOOK.md). The comment behaviour is in [COMMENTS.md](COMMENTS.md).

## Decisions in force

- **One connector per process.** The connectors service runs one connector, chosen by `PARMANA_CONNECTOR`. The GitHub connector therefore needs its own deployment. The Razorpay deployment must not be reused.
- **Base64 credential.** `GITHUB_APP_CREDENTIAL` is `<app id>:<installation id>:<base64 PEM>`. A raw PEM is refused, because its line breaks do not fit in an environment variable.
- **Least privilege.** Start with Pull requests: read and write, and no Contents access, which only `github:pr-merge` needs.
- **Two approvals per comment.** The `github-pr-comment` policy approves a comment only when a trusted person has approved the exact target and a second approval covers the exact comment text (parmana-core #608).
- **Comments are not retried.** If the answer to a post is lost, the connector reports that the comment may have been posted, and does not send it again.
- **Signed commits on `main`.** Every commit that reaches `main` must be signed. Sign-off (DCO) is required as well.
- **Merging is a human step.** No merge happens without the person responsible for the repository.

## Open risks

- **Repeat risk.** A new, separately approved request posts another comment. The release ledger stops a repeat of the same release, but not a new approval. The owner must accept this before real use.
- **Comments before the marker.** Comments posted before #72 have no marker, so the recovery search cannot find them.
- **Single approver in production.** The threat model says one person currently holds both roles. The policy approval and the registration each need a second person.
- **No live run yet.** Nothing has yet run a signed release through the GitHub service to the live GitHub API.

## Steps

| # | Step | Who | Why | When |
| --- | --- | --- | --- | --- |
| 1 | Sign the #72 commits with GPG and push | Operator, on their PC | `main` requires signed commits | Now |
| 2 | Merge #72 | Operator, or the team | Makes the marker available to recovery | After 1 |
| 3 | Sign the #608 commit with GPG and push | Operator, on their PC | Same signing rule, for `parmana-core` | Now |
| 4 | Propose `github-pr-comment` 1.0.0 in the production maker-checker flow, with a second approver | Operator, plus a second person | The CI gate fails a policy with no logged production approval. The threat model says one person holds both roles today, so a second approver must be arranged first | Independent of 1–3 |
| 5 | Export the approval to the governance log with the read-only `CI_DATABASE_URL`, verify it, and push the change to #608 | Operator | Makes `verify-policy-approvals` pass | After 4 |
| 6 | Merge #608 | Operator, or the team, once the gate is green | The policy must be in `main` before the registration names it | After 5 |
| 7 | Deploy a **separate** Vercel project for GitHub, with `PARMANA_CONNECTOR=github` and `GITHUB_APP_CREDENTIAL` | Operator | One connector runs per process. The existing production project runs Razorpay, so GitHub cannot share it | After 2 |
| 8 | Propose the `github:comment` registration in core, with the GitHub project's endpoint and policy `github-pr-comment` 1.0.0 | Maker | Registration is maker-checker | After 6 and 7 |
| 9 | Approve the registration with a step-up signature | Checker, a second person | The maker cannot approve their own change | After 8 |
| 10 | Controlled test: approve one short comment on the test PR | Operator | Checks the whole path against the real GitHub API | After 9 |
| 11 | Send the same release again, then revoke the registration | Operator | Checks the ledger blocks a repeat, and that revoke stops calls | After 10 |
| 12 | Decide the repeat risk | Owner | Blocks real use on repositories | Before real repos |

## Fix needed in the runbook

`RUNBOOK.md`, step 4b, gives the endpoint as `https://parmana-connectors.vercel.app/api/execute`. That is the **Razorpay** project. Registering it would send GitHub comments to the wrong service. Step 7 creates a separate project, and step 8 must use that project's URL. The runbook should be corrected before step 8.

## Blocking decisions

- **Second approver** for steps 4 and 9. Without one, neither can be completed.
- **Repeat risk** for step 12. A new approval posts another comment, which is intended, but the owner must accept it.
- **Merge capability** (`github:pr-merge`) is not part of this plan. It needs its own review.
