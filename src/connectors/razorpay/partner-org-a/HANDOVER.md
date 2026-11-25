# Handover to partner org A: refunds through Parmana

## What is changing

Refunds of Razorpay payments that come from your systems will be checked by Parmana before they happen. Parmana decides whether each refund is allowed, and records the decision. Parmana also performs the refund itself, through its Razorpay connector.

## Why

Today a refund can be made by calling Razorpay directly with a key your system holds. Parmana can only check refunds that pass through it. Moving the key and the refund step to Parmana closes that path.

## What you must do

1. **Ask Parmana for a decision before each refund.** Call `POST /v1/inbound/checks` with `capability: "payments:refund"`, your audience, the payment id as `target`, and the amount in paise as `parameters.amount` (100 = Rs 1). The example in `partner-refund-check.example.mjs` shows the call.
2. **Refuse anything that is not approved.** This includes errors, timeouts and network failures.
3. **Check both signatures and the expiry** before acting on a decision. Every decision carries an Ed25519 signature (`signature`) and an ML-DSA-65 post-quantum signature (`secondarySignature`), both over the same fields. A decision missing either one is refused. The example shows how.
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

- Obtain Parmana's Ed25519 gateway public key and ML-DSA-65 public key, and check them against the keys Parmana publishes, before go-live.
- Confirm the amount limit set for your grant, in paise, on the path `parameters.amount`.
- Agree on the date the Razorpay key is retired.
