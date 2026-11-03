# Connector migration: steps to resume

Last updated 3 November 2026. This file lists what is done, what is waiting, and what to do next. Read it first when you come back to this work.

Background: ADR-0018 in parmana-core was accepted by the operator on 2 November 2026 (parmana-core PR #294). It moves each vendor connector out of parmana-core into this repository, one at a time, in a set order.

## 0. Resume here (written 2 November 2026, end of day; status updated 3 November 2026)

Start here tomorrow.

### Where things stand

- **Connectors in parmana-connectors (`main`):** Razorpay, Paytm, Slack, GitHub, HubSpot, Zerodha (paper only). All merged.
- **Removed from parmana-core:** Zerodha (parmana-core #295), Slack (#296), Paytm (#297), GitHub (#299), HubSpot (#300), all merged.
- **Still in parmana-core:** no vendor connector.
- **Core coverage lost (operator approved):** the seven tests that exercised Paytm through core's gate, the approval-email integration test, and the offline check that ran a Paytm refund through the stack. Rewriting the gate tests against a core test connector is open.
- **Nothing is live.** No live traffic, no vendor credentials in production, no live money.

### Do these first tomorrow

1. **Razorpay preview test** (section 6, step 1). Needs your Vercel login and a local core. Steps are in `RESUME.md`.

2. **Razorpay registration in parmana-core.** You are the maker. Mamta approves with her own key.

### Remaining steps, in order

- GitHub and HubSpot were removed from core before their registrations were approved (operator's decision). Their registrations are still open, so neither can run live yet.
- Rewrite the seven removed core tests against a core test connector, if you want core's gate covered by its own proof again.
- Decide open items in section 4 before Slack or GitHub goes live.

### Notes for the next session

- Main in parmana-core has the unsigned Slack commit `ff324c5`, merged in PR #296. The signed copy is on the Slack branch as `f56e60c`. Nothing needs doing unless you want history rewritten, which I'd leave alone.
- Permission checks block deleting security-sensitive tests. Ask for approval in the session before deleting tests again.

---

## 1. Done

### Code in parmana-connectors (on `main`)

| Connector | Capability | Mode | PR |
| --- | --- | --- | --- |
| Razorpay | `razorpay:refund` | test mode | #16 (folder layout), earlier PRs for the service |
| Paytm | `paytm:refund` | staging only | #18 |
| Slack | `slack:post-message` | not run against a live workspace yet | #19 |
| GitHub | `github:pr-fetch`, `github:pr-merge` | GitHub App | #20 |
| HubSpot | `hubspot:deal-fetch`, `hubspot:deal-update` | Private App | #21 |
| Zerodha | `zerodha:place-order` | paper only, no live mode | #22 |

Each connector is in its own folder under `src/connectors/<vendor>/`, with its README, and its tests are under `tests/connectors/<vendor>/`. The import rule is checked by `tests/boundaries.test.ts`.

### Documents

- `RESUME.md` has the migration status section (PR #17).
- ADR-0018 is accepted (parmana-core PR #294).

### Removal from parmana-core

- Zerodha: removed from parmana-core (parmana-core PR #295, merged 19:01 UTC, 2 November 2026). This happened before parmana-connectors PR #22 merged, so for about three minutes the code existed only in git history. It is now on `main` in parmana-connectors.
- Slack (parmana-core PR #296), Paytm (#297), GitHub (#299) and HubSpot (#300) were also removed. All four are merged, and each now lives in parmana-connectors.

## 2. Still in parmana-core

No production vendor connector is in parmana-core. The connector SDK (`packages/connector-sdk`) still ships four sample vendor connectors (Oracle, Salesforce, SAP, Workday), which are not in the migration order. Razorpay, Paytm, Slack, GitHub, HubSpot and Zerodha each have one copy, in parmana-connectors.

## 3. Waiting on people, not code

Registration in parmana-core is a maker and checker step. The maker is the operator. The checker must be a different person with their own key. For this migration the checker is Mamta.

| Step | Who | Status |
| --- | --- | --- |
| Razorpay signed-release test through the preview | operator (needs Vercel login and a local core) | not run. Steps are in `RESUME.md` |
| Razorpay production registration in parmana-core | operator (maker), Mamta (checker) | open |
| Paytm registration | operator, Mamta | not needed: Paytm was removed from core (#297) |
| Slack registration | operator, Mamta | open |
| GitHub registration | operator, Mamta | open |
| HubSpot registration | operator, Mamta | open |

Removals follow each registration. Do not remove a connector from parmana-core until its registration is approved and its checks pass.

I have not checked the live registrations. They are held in the running parmana-core system, not in this repository. Check them there before you start the list above.

## 4. Open decisions

- **Slack repeats.** Slack gives no receipt. A repeated release posts again. Decide before Slack goes live. One option is to check recent channel history first.
- **GitHub repeats.** A repeated merge of a merged pull request fails at GitHub instead of merging twice. The connector does not check first.
- **Live money.** Off for every connector. Zerodha has no live mode in this repo. Paytm runs staging only. Production needs a separate approval for each.
- **Verifier.** The Python `dilithium3` work in `parmana-verifier` is on branch `claude/verifier-ml-dsa-python`, with no PR. Its commit has the wrong author and must be re-signed before it can merge. Issues `parmana-verifier#27` and `#28` track it. parmana-core issue `#291` tracks the v3 rollout.

## 5. Signing rule

`main` in both repos requires signed commits. Every PR from this work needs the operator's signature. From the operator's machine, in the repo's folder:

```bash
git fetch origin main
git fetch origin <branch>
git checkout <branch>
git config user.signingkey EA52495306CAD70F
git rebase --exec "git commit --amend --no-edit -S -s" origin/main
git log --format="%h %G? %s" origin/main..HEAD
git push --force-with-lease origin <branch>
```

Replace `<branch>` with the PR's branch. The `git log` should show only that PR's commits, each with `G`. If it lists commits from other PRs, stop and fetch `origin/main` again. Rebasing onto a stale `main` re-applies merged commits.

## 6. Next steps, in order

1. Run the Razorpay preview test in `RESUME.md`, and record the result.
2. Check the live registrations in parmana-core. Record which connectors are registered.
3. Prepare the Razorpay registration request. The operator makes it. Mamta approves it with her own key.
4. After Razorpay is approved and live-checked, get Mamta's approval for the GitHub and HubSpot registrations. No further production connector needs removing from core. The SDK's sample connectors are not in the migration order and are not moved.
5. Decide the open items in section 4 before Slack or GitHub goes live.
6. Keep live money off until there is a separate approval for each connector.
