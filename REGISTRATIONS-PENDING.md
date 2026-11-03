> Master copy: parmana-core `docs/REGISTRATIONS-PENDING.md`. This copy is for readers of parmana-connectors. Keep the two in step.

# Connector registrations pending

Status as of 3 November 2026, taken from origin/main after PR #301.

## Status

Four connector registrations are open in parmana-core: Razorpay, GitHub, HubSpot and Slack. Paytm needs none, and Zerodha is paper only with no live mode.

| Connector | Registration | Blocker                                                                   |
| --------- | ------------ | ------------------------------------------------------------------------- |
| Razorpay  | Open         | Preview signed-release test not run. Needs Vercel login and a local core. |
| GitHub    | Open         | Code already removed from core (parmana-core #299), before approval.      |
| HubSpot   | Open         | Code already removed from core (parmana-core #300), before approval.      |
| Slack     | Open         | Code already removed from core (parmana-core #296), before approval.      |
| Paytm     | Not needed   | Removed from core (#297). Staging only.                                   |
| Zerodha   | Not needed   | Paper only. No live mode in parmana-connectors.                           |

## Why it is needed

A connector can change a real system, such as issuing a refund or updating a deal. A second person must approve it before it can run in production.

- **Separation of duties.** The maker proposes. The checker approves with a separate key. The server refuses a maker approving their own change (`SameActorCannotApproveOwnChangeError`).
- **Scope.** Only the checkers listed for a policy can approve it (`POLICY_CHANGE_CHECKERS`).
- **Current rule.** Nothing is live. No live traffic, no vendor credentials in production, and no live money until each connector has its approval.

## How to register

The repo has no separate connector-registration command. A connector's registration is the maker and checker approval of its policy, following `docs/runbooks/POLICY-CHANGE-APPROVAL.md`. This reading is mine. Confirm it before the first registration.

1. **Maker** proposes the policy change with a `reason`. The server returns `PENDING_APPROVAL`.
2. **Checker** signs a step-up envelope for that change and approves it, or rejects it with a `rejectionReason`.
3. **Server** runs its checks in order. The first failure decides the response.

| Order | Check                                   | Refusal                                    |
| ----- | --------------------------------------- | ------------------------------------------ |
| 1     | Caller authenticated                    | `401`                                      |
| 2     | Caller is human (`USER`)                | refused                                    |
| 3     | Change exists                           | not found                                  |
| 4     | Checker is not the maker                | `SameActorCannotApproveOwnChangeError`     |
| 5     | Checker is listed for this policy       | `403 CHECKER_NOT_IN_SCOPE`                 |
| 6     | Step-up envelope valid                  | `STEP_UP_AUTHORIZATION_INVALID`            |
| 7     | Change still `PENDING_APPROVAL`         | conflict                                   |
| 8     | Live policy and approval record written | marked `APPROVED` only after this succeeds |

The envelope is valid for 120 seconds. If the machine clock is more than about two minutes behind the server, every approval fails with `STEP_UP_AUTHORIZATION_INVALID`. Check the clock first.

## Commands

Replace every `<angle bracket>` value before running. Do not run a line that still has a placeholder. Run in Windows PowerShell from the repo folder.

**0. Set the production URL and check the clock**

```powershell
$env:PARMANA_URL = "<production base URL>"
"local UTC: $((Get-Date).ToUniversalTime().ToString('o'))"
```

**1. Maker proposes the change**

```powershell
$body = @{ proposedContent = $policy; reason = "<why this change>" } | ConvertTo-Json -Depth 20
Invoke-RestMethod -Method Post -Uri "$env:PARMANA_URL/policies/<policy name>/<version>/pending-changes" -Headers @{ Authorization = "Bearer $maker" } -ContentType "application/json" -Body $body
```

Note the `pendingPolicyChangeId` in the response. Use it as `<ID>` below.

**2. Checker approves**

```powershell
$out = npx tsx scripts/sign-policy-change-step-up.ts --private-key-file <checker.step-up.private.pem> --key-id checker-step-up --pending-policy-change-id <ID> --action approve
$envelope = $out | Where-Object { $_ -like '{"payload"*' }
$body = '{"stepUpAuthorization":' + $envelope + '}'
Invoke-RestMethod -Method Post -Uri "$env:PARMANA_URL/policies/pending-changes/<ID>/approve" -Headers @{ Authorization = "Bearer $checker" } -ContentType "application/json" -Body $body
```

Sign and send in one step. Do not pass the envelope through `ConvertFrom-Json`.

**Or the checker rejects**

```powershell
$out = npx tsx scripts/sign-policy-change-step-up.ts --private-key-file <checker.step-up.private.pem> --key-id checker-step-up --pending-policy-change-id <ID> --action reject
$envelope = $out | Where-Object { $_ -like '{"payload"*' }
$rb = '{"stepUpAuthorization":' + $envelope + ',"rejectionReason":"<why>"}'
Invoke-RestMethod -Method Post -Uri "$env:PARMANA_URL/policies/pending-changes/<ID>/reject" -Headers @{ Authorization = "Bearer $checker" } -ContentType "application/json" -Body $rb
```

**Expected:** `status : APPROVED` (or `REJECTED`), with `resolvedBy` set to the checker.

## Open decisions

- [ ] **Confirm the registration mechanism.** This document reads registration as the policy approval in the runbook. The repo does not say so. The operator and Mamta should agree before the first registration.
- [ ] **Map each connector to its policy names.** Find them in the policies directory. Expected: Razorpay refund, GitHub PR approval, HubSpot deal update, Slack post, Paytm refund.
- [ ] **Add Mamta to `POLICY_CHANGE_CHECKERS`** for each of those policies. The value is a JSON object keyed by policy name. The checker's `callerId` must match her key.
- [ ] **Give Mamta a step-up key pair.** Her public key goes in `stepUpPublicKey` on her key entry. She keeps the private key.
- [ ] **Decide who registers Razorpay.** `docs/runbooks/RAZORPAY-REFUND.md` lists this as open.
- [ ] **Run the Razorpay preview signed-release test** first. It needs a Vercel login and a local core.

## Sources

- `docs/runbooks/POLICY-CHANGE-APPROVAL.md` (roles, the server's checks, the step-up envelope, commands)
- `docs/RESUME-CONNECTOR-MIGRATION.md`, and the STEPS.md in parmana-connectors (registration status and the maker and checker roles)
- `docs/runbooks/RAZORPAY-REFUND.md` (open decision on who registers the connector)
