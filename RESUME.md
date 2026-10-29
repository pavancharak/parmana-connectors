# parmana-connectors: resume notes

Resume here. The deployment runbook is `RUNBOOK.md` and the variable list is `SETUP.md`, both on `main`.

## Where things stand

- **Production connector is live** at https://parmana-connectors.vercel.app. `/api/health` returns UP. `/api/execute` refuses an unsigned request with HTTP 400, which shows its settings load and its database connects.
- **Production variables are set.** `RAZORPAY_KEY_PAIR` is set. Confirm it is a test key.
- **Merged:** connectors PRs #2 to #9, core PR #214. The connectors remote has only `main`. Core has `main` plus two unmerged branches.
- **Local core runs and passes.** `docker compose up -d --build --wait`, then `& "C:\Program Files\Git\bin\bash.exe" docker/local/quickstart-check.sh` exits 0. Use Git Bash, not the WSL `bash`.
- **Preview test is set up but not yet run.** Branch `test/razorpay-preview` at commit `2781b1a`. Preview deployment `mek4olxw9` is Ready, but it was built before the Preview variables were added, so it does not use them yet.
- **Blocked:** Vercel's free plan hit its daily deployment limit (`api-deployments-free-per-day`). Redeploys and pushes fail until about 20:33 IST on 30 October 2026.

## Tomorrow's steps, in order

1. **Redeploy the preview.** In the Vercel dashboard, open **Deployments**, find the `test/razorpay-preview` deployment (`mek4olxw9`), and choose **… → Redeploy** with environment Preview. Wait for Ready. The redeploy picks up the Preview variables.
2. **Check the preview is configured.** Run `vercel curl https://parmana-connectors-mek4olxw9-pavan-dev-singh-charaks-projects.vercel.app/api/execute -- -X POST -H "Content-Type: application/json" -d "{}"`. Expected: `{"error":"request body is not a signed release"}`.
3. **Register the preview in the local core** as an external connector for `razorpay:refund`, with policy `customer-refund` 1.2.0. Use two different local API keys, one to propose and one to approve. Endpoint: the preview URL plus `/api/execute`, exactly as set above. Follow `docs/site/guides/connect-any-external-system.mdx`.
4. **Sign a small test release** in the local core, using a test-mode payment ID, and send it to the preview's `/api/execute`. Expected: `200` with `"success":true` and a refund in Razorpay test mode. Confirm the exact local signing command in the core's `examples/live-checks/external-connector` before running it.
5. **Record the result** in this file, under Where things stand.

If step 2 fails, read the preview's runtime log with `vercel logs <preview-url> --json`, and find the `reason`.

## Open items and who owns each

| # | Item | Owner | Status |
| --- | --- | --- | --- |
| 2 | `RAZORPAY_KEY_PAIR` is a test key | You | Set. Confirm the key id starts with `rzp_test_` |
| 3 | Registration in parmana-core for production | Operator, with a second person | Open. Production needs maker and checker as two people |
| 4 | `PARMANA_PUBLIC_KEY` matches `/keys/default` | You | The served key matches. The stored Vercel value is unverified; reveal it in the dashboard |
| 5 | Signed release through the test refund path | Joint | Test plan above; blocked by the Vercel limit until tomorrow |
| 6 | Supabase project slots | You | Open. The free plan has two slots, and both are used |
| 7 | Two unmerged parmana-core branches | You | Open. Port their notes to `main`, or delete them |
| 8 | Live money | You | Off. Not approved |
| 9 | `TS2688` build warning | Later | Not blocking |

Security: the Vercel bypass token appeared again in debug output. Confirm it was regenerated, and treat the old value as exposed.

## Razorpay connector: what is done and what is left

**Done and verified**

- The `razorpay:refund` connector refunds one payment by a `pay_` id, for a positive amount in paise, with the release's `businessTransactionId` as the receipt. A repeat returns the existing refund, not a second one.
- Its refusals: a target that is not a payment id, a zero amount, a malformed key pair, and a live key unless `PARMANA_ALLOW_LIVE_KEYS` is true. Each refusal happens before any call to Razorpay.
- The service: signed-release checks, the replay store, the health route, the shutdown handling, and the Vercel adapter.
- Test-mode run against Razorpay: 4 of 4 checks passed on 29 October 2026.
- Production runs the service and refuses unsigned requests.

**Left, in order**

1. **Preview test with a signed release.** Redeploy the preview once Vercel's daily limit resets, then run the steps above. This is the first end-to-end proof.
2. **Production registration in parmana-core.** The operator, with a second person as checker. Production cannot take a release until this is approved.
3. **Production test of a signed release**, in Razorpay test mode, after step 2. Expected: a refund that repeats safely.
4. **Confirm the production key values.** `RAZORPAY_KEY_PAIR` must be a test key. The stored `PARMANA_PUBLIC_KEY` must match `/keys/default`.
5. **Postgres tests.** Done locally against PostgreSQL 16: all 86 tests pass, including the 3 replay-store tests that need a database. CI should show the same on its PostgreSQL service.
6. **Node 24 check.** Done: the build and all 86 tests pass on Node 24.22.
7. **The `TS2688` warning** in Vercel's build log. Not blocking. Fix it in its own PR.
8. **Monitoring.** Logs exist, but no alerts. Decide what should alert, and who acts on it.
9. **The crash case.** A release is recorded before the connector runs. If the process stops during a refund, that release stays refused, and someone must check Razorpay by hand. The README documents this. The written procedure is in `RUNBOOK.md`, under "Recovering a release that was recorded but not confirmed". Razorpay's own refund check is the step that decides it.
10. **Live money.** Off. It needs a separate approval, a live key, and `PARMANA_ALLOW_LIVE_KEYS=true` only after that approval.
11. **Paytm move** (ADR-0018). It waits until the Razorpay connector is live from this repository.

Nothing is left in parmana-core for Razorpay. The old connector was removed on 12 August 2026.
