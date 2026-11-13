# GitHub connector: status

Current state of the GitHub connector and its rollout. The plan and the steps are in [ROLLOUT.md](ROLLOUT.md). The commands are in [RUNBOOK.md](RUNBOOK.md). The comment behaviour is in [COMMENTS.md](COMMENTS.md).

## Status

Last updated after the `github:comment` edge-case tests were pushed to `claude/optimistic-cori-hmha8u` (59fc43a).

| Part | State |
| --- | --- |
| `github:comment` capability | Merged to `main` (#69) |
| Transaction marker in comments | Merged to `main` (#72) |
| Comment documentation (`COMMENTS.md`) | Merged to `main` (#72) |
| Connector runbook (`RUNBOOK.md`) | Merged to `main` (#71), moved again by #76 |
| Endpoint placeholder in the runbook | Merged to `main` (#74) |
| Rollout plan (`ROLLOUT.md`) | Merged to `main` (#73) |
| Public workflow (`docs/WORKFLOW.md`) | Merged to `main` (#75) |
| Runbook move into connector folders | Merged to `main` (#76) |
| `github:comment` edge-case unit tests (31 GitHub tests in total) | On `claude/optimistic-cori-hmha8u` (59fc43a), not yet merged to `main` |
| `github-pr-comment` policy | Built in parmana-core #605 (draft). Signed commit `4e7ea91` is on the branch |
| `github-pr-comment` production approval (maker-checker) | Pending. Needs a second approver |
| Governance log entry | Not started. Waits on the approval |
| Merge of parmana-core #605 | Not started. Waits on the approval and the log entry |
| Separate GitHub deployment | Not started |
| Core registration of `github:comment` | Not started |
| Live test on a real PR | Not run. The unit tests do not contact GitHub |
| Repeat-risk decision | Open |

## History

What was built, in order, and why each decision was made.

| When | PR | What | Why |
| --- | --- | --- | --- |
| Nov 2026 | #69 | `github:comment` added to the existing GitHub connector | Reuses the connector's App authentication, target parsing and error handling, rather than a second endpoint |
| Nov 2026 | #71 | Runbook added, first in the repository root, later moved here | Connector runbooks belong beside the connector they describe |
| Nov 2026 | #72 | Transaction ID marker added to each comment | A lost answer must be matchable to its release, without a second source of truth |
| Nov 2026 | #73 | Rollout plan added | The steps for production were spread across several conversations |
| Nov 2026 | #74 | Runbook endpoint changed from the Razorpay project to a placeholder | Registering the Razorpay endpoint would send GitHub comments to the wrong service |
| Nov 2026 | #75 | `docs/WORKFLOW.md` added; links to a private `STEPS.md` removed | `STEPS.md` is ignored on purpose as private (#33), so public steps go in a tracked file |
| Nov 2026 | #76 | Razorpay deployment runbook moved to `src/connectors/razorpay/` | It is a connector deployment runbook, and it sits with its connector |
| Nov 2026 | #77, #78 | Status and history brought up to date; signed policy commit recorded on the branch | Keeps the rollout record in step with the branch |
| Nov 2026 | 59fc43a (branch) | Edge-case tests for `github:comment`: reply without id, reply that is not JSON, timeout, maximum body length | These paths had no test; the describe name was also fixed |
| Nov 2026 | parmana-core #605 | `github-pr-comment` 1.0.0 policy added, with a test | The registration names the policy, so it must exist in core first |
