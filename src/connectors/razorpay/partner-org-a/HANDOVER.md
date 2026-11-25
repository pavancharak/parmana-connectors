# Handover to partner org A: refunds through Parmana

## What is changing

Refunds of Razorpay payments that come from your systems will be checked by Parmana before they happen. Parmana decides whether each refund is allowed, and records the decision. Parmana also performs the refund itself, through its Razorpay connector.

## Why

Today a refund can be made by calling Razorpay directly with a key your system holds. Parmana can only check refunds that pass through it. Moving the key and the refund step to Parmana closes that path.

## What you must do

1. **Ask Parmana for a decision before each refund.** Call `POST /v1/inbound/checks` with `capability: "payments:refund"`, your audience, the payment id as `target`, and the amount as `parameters.amountInr`. The example in `partner-refund-check.example.mjs` shows the call.
2. **Refuse anything that is not approved.** This includes errors, timeouts and network failures.
3. **Check the decision's signature and expiry** before acting on it. The example shows how.
4. **Stop calling Razorpay directly** once Parmana's refund path is in place. This means retiring the Razorpay key you hold, after agreement with Parmana and Razorpay.
5. **Tell us your refund route address and its owner**, so the no-bypass probe can test that direct calls are refused.

## What Parmana will verify

- Every refund has a decision recorded by Parmana, with its outcome, policy and time.
- Direct calls to your refund route, made without an approval, are refused. This is tested on a schedule once the route is configured.
- Each probe result is signed and recorded, and an unexpected acceptance raises an alert.

## What this does not cover

- Approval decisions are made automatically against the policy and grant limits. No person approves each refund yet.
- Parmana cannot see a refund made by someone who still holds a Razorpay key. Step 4 is what closes this.

## Open items

- Confirm the signature key and algorithm for verifying decisions.
- Confirm the amount limit set for your grant.
- Agree on the date the Razorpay key is retired.
