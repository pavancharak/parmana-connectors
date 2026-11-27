# Partner org A: Razorpay refunds through Parmana

This folder holds what is needed to bring one partner's refund flow under Parmana's check (gap G-129). Nothing here runs in production yet. It waits on the partner's refund address and on their agreement to move the Razorpay key.

## Contents

| File | Purpose |
| --- | --- |
| `partner-refund-check.example.mjs` | Example the partner's system adapts: asks Parmana for a decision before a refund, and refuses anything that is not an approved, signed, unexpired decision. |
| `probe-target.env.example` | Settings for the no-bypass probe, to point at the partner's refund route once it is known. |
| `HANDOVER.md` | Written handover for the partner: what changes, what they must do, and what Parmana will verify. |

## What is and is not covered

- The check (`POST /v1/inbound/checks`) decides whether a refund may happen. It does not perform the refund.
- The refund itself must be done through Parmana's Razorpay connector, which holds the key. Until the partner stops holding a Razorpay key, they can still refund directly, and this flow does not stop that.
- The probe reports whether a direct call to the partner's route is refused. It can only run once the route address is given.

## Open items

- Partner's refund route address and owner.
- Agreement to move the Razorpay key to Parmana.
- Obtain Parmana's Ed25519 gateway public key and ML-DSA-65 public key for verifying decisions. Check both against the keys Parmana publishes before go-live.
- The grant limit for the partner (path `parameters.amount`, in paise). Confirm it matches the grant set up for them.
