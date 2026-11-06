# Google AX refund: acceptance test

Prototype for the integration of a refund agent running in Google AX with
Parmana. The agent proposes a refund; Parmana core decides whether it may run
and signs a release; the connectors service verifies that release and runs the
refund once.

## What this directory tests

`refund.acceptance.test.ts` runs the real connectors service (`createService`)
with a fake Razorpay-style connector, and submits releases to it the way
parmana-core does.

| Scenario | Expected |
| --- | --- |
| Authorized refund, signed by core | Connector runs once, returns 200 |
| The same release sent again | Refused, connector not run again |
| Release signed by a key other than core's | Refused, connector not run |
| Release altered after signing (amount raised) | Refused, connector not run |
| Release addressed to another endpoint | Refused, connector not run |
| Expired release | Refused, connector not run |
| Release lasting longer than 60 s | Refused, connector not run |
| Capability this connector does not serve | Refused, connector not run |
| Body that is not a signed release | Refused with 400, connector not run |

## What it does not test

- **Approval and revocation.** Whether a refund needs a manager's approval, and
  whether that approval is still valid when the refund runs, are decided by
  parmana-core's policy and approval checks before core signs a release. Those
  checks live in parmana-core, not here. The test key signs releases here in
  core's place.
- **Google AX.** The agent is a stand-in: the test submits a release directly.
  No AX API is called. Google AX is outside the GitHub access granted to this
  session, so its interfaces were not checked against its code.
- **Evidence.** The signed record that parmana-verifier checks is not produced
  or verified here.

## Run

From the repository root, after `npm ci`:

```bash
npx vitest run examples/google-ax-refund
```
