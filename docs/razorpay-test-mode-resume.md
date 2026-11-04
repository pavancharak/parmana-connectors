# Parmana Razorpay test-mode run: resume notes

Date recorded: 2026-11-04

## Goal

Get one real signed Parmana refund through Razorpay test mode, so the AgenTrust
`parmana-server` integration can cite an observed effect instead of a mock.

No real money moves at any step. Razorpay test mode only.

## Done

| Item | Result |
|---|---|
| parmana-connectors Razorpay test-run (`src/connectors/razorpay/test-run.mjs`) | 4 of 4 checks passed. Test refund `rfnd_Tvx213k6a2oKPz`, processed. |
| parmana-connectors `.env` | Key pair and test payment ID set. Not committed. |
| parmana-connectors health | `https://parmana-connectors.vercel.app/api/health` returns UP. |
| parmana-connectors `GET /api/execute` | Returns HTTP 500. Not yet investigated. |
| parmana-razorpay-demo endpoint | Deployed to `https://parmana-razorpay-demo.vercel.app`. Refuses an empty request with HTTP 401, "the body is not { release, signature }". |
| Vercel env (demo endpoint) | `RAZORPAY_KEY_ID` already existed. Secret entry was pending. Confirm both are set to the test key pair before the refund step. |
| Earlier merges | parmana-core #317, parmana-verifier #29 and #30, all merged. AgenTrust integrations #415 open, waiting on code-owner approval. |

## Pending, in order

1. **Production policy change (maker proposes, checker approves).** Paused until the user says to continue.
   - Maker: `npx tsx examples/live-checks/governance.ts propose-policy --file examples/razorpay-refund/policy.json`
   - Record the printed `<id>`.
   - Checker: approve with the step-up key. Run only after the user confirms.
2. **Connector capability `razorpay:refund`**, released to `https://parmana-razorpay-demo.vercel.app/api/refund` (demo README step 3).
3. **Agent key** for `razorpay-demo-agent`, allowed only `razorpay:refund` (demo README step 4). This writes to production API keys.
4. **Agent grant**, up to 500 paise per refund, 7 days (demo README step 5).
5. **Demo, four requests** (demo README step 6). Request 2 is the one that creates the refund. Do not resend it on timeout. Read the trust record first.
6. **Check the Razorpay dashboard** (Test Mode, Refunds): one ₹1 refund, receipt equal to the transaction ID from request 2.

## Separate option: parmana-connectors as the release endpoint

Would register `https://parmana-connectors.vercel.app/api/execute` as a capability endpoint in production. Same kind of production change, so it needs its own confirmation. Not started. Also needs the GET 500 investigated first.

## Decisions still open

- Whether to continue the production policy change at all.
- Whether the connector service (option 2) is needed for the AgenTrust claim, or the demo endpoint is enough.
- The draft policy is not approved for production use.

## Risks noted

- The policy change affects live decisions on the production API for anyone using that policy.
- Request 2 can create a refund. A timeout does not mean it failed.
- Test keys and secrets stay in the password manager and `.env` only. Never paste them into chat.
- `.env` in `parmana-connectors` holds the test secret. Confirm it is not tracked by git before any commit.

## Resume checklist

- Confirm the Vercel `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set on `parmana-razorpay-demo`, then redeploy.
- Confirm the production policy change is wanted.
- Start from pending step 1.
