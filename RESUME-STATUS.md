# Resume status: connector migration (parmana-connectors)

Status as of 3 November 2026. Read this first when you come back to this work. STEPS.md has the full ordered list. The registration commands are in parmana-core, in `docs/REGISTRATIONS-PENDING.md`.

## Current status

- This repo holds one folder per connector under `src/connectors/`: github, hubspot, paytm, razorpay, slack, zerodha. All are on `main`.
- Razorpay, Paytm, Slack, GitHub and HubSpot have each been removed from parmana-core. Zerodha was removed too, and is paper only (no live mode).
- Registrations in parmana-core are still open for Razorpay, GitHub, HubSpot and Slack. Paytm needs none.
- Nothing is live. No live traffic, no vendor credentials in production, no live money.
- The shared contract is `src/connector-contract.ts`. It imports nothing. Vendor folders may import only Node built-ins, their own folder, and that contract.

## What happened

1. ADR-0018 was accepted on 2 November, and the migration started with Razorpay.
2. Zerodha (#22), Slack (#19), Paytm (#18), GitHub (#20) and HubSpot (#21) were moved here, one PR each.
3. Each one was removed from parmana-core, in order: Zerodha #295, Slack #296, Paytm #297, GitHub #299, HubSpot #300.
4. The status docs were updated to match: STEPS.md (#25) and parmana-core #301.

## What is left

- [ ] Registrations in parmana-core for Razorpay, GitHub, HubSpot and Slack. See `docs/REGISTRATIONS-PENDING.md` in parmana-core for the steps.
- [ ] Razorpay preview signed-release test. It needs a Vercel login and a local core.
- [ ] Decide the open items in STEPS.md, section 4, before Slack or GitHub goes live.
- [ ] Decide whether the SDK's sample vendor connectors (Oracle, Salesforce, SAP, Workday) stay in parmana-core. They are not in the migration order.
- [ ] The Python `dilithium3` work in parmana-verifier has no PR and needs re-signing. Tracked by parmana-verifier #27 and #28.

## Recommended order

Do these in order. Each step depends on the one before it. The registration steps are in parmana-core `docs/REGISTRATIONS-PENDING.md`.

1. **Confirm the registration mechanism with Mamta.** This is the first step. Nothing else starts until she agrees that a registration is the policy approval in parmana-core `docs/runbooks/POLICY-CHANGE-APPROVAL.md`, or until a different process is agreed. Record the decision here.
2. **Run the Razorpay preview signed-release test.** It needs a Vercel login and a local core, so the operator runs it. Record the result here.
3. **Register Razorpay only.** Stop and review before any other connector.
4. **Decide, for each of GitHub, HubSpot and Slack, whether it should run at all.** Their code is already out of core. Only after that decision, propose its registration.
5. **Optional, not blocking:** rewrite the seven core gate tests removed with Paytm, against a core test connector. Decide whether the SDK's four sample vendor connectors stay in parmana-core. Open the parmana-verifier `dilithium3` PR (issues #27 and #28).

Live money stays off until each connector has its own approval.

## Why

Each vendor connector runs in its own repo, so its code and credentials stay outside the core. A registration in core is then a separate, reviewed step, with a maker and a checker.

## How

Work in one repo at a time. Each change goes on a branch from a fresh `origin/main`, then gets signed and pushed. The signing block is in STEPS.md, section 5.

## Steps, in order

1. Read STEPS.md, section 0, for the current position.
2. Run the Razorpay preview test. Record the result.
3. In parmana-core, follow `docs/REGISTRATIONS-PENDING.md`: maker proposes, checker approves.
4. Confirm each registration is `APPROVED` before moving to the next connector.
5. Only after approval, decide whether any other step needs doing.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Commit shows `N` (unsigned) | Commit was made without the signing block | Run the signing block in STEPS.md, section 5 |
| DCO check fails | Sign-off name does not match the author name | Set `git config user.name` to the author name, then rerun the signing block |
| `git push --force-with-lease` says "stale info" | Local copy of the remote branch is out of date | Fetch the branch, then rebase from the fresh remote tip |
| Commits show as unverified | Local branch points at an old commit | Move the local branch to the remote tip. Do not change the author identity |
| Vercel "deployment rate limited" | Vercel quota, not code | Retry in 24 hours |
| Pre-commit gitleaks not found | Gitleaks not on PATH | Add its folder to PATH and retry. Do not use `--no-verify` |

## Checklist before merging a connector change

- [ ] The change is on a branch from fresh `origin/main`.
- [ ] Build, typecheck and tests pass locally.
- [ ] The commit is signed (`G`) and has a sign-off that matches the author.
- [ ] The change does not add live traffic, vendor credentials or live money.
