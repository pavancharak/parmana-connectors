# Razorpay connector

`src/connectors/razorpay/razorpay-connector.ts` runs one capability, `razorpay:refund`. It refunds a payment once, even when the same release is sent twice. The code is in that file, and its tests are in `tests/connectors/razorpay/razorpay-connector.test.ts`.

## Request

The release must carry:

| Field | Value | Checked by the connector |
| --- | --- | --- |
| `capability` | `razorpay:refund` | Yes. Any other capability is refused as `unknown_capability` |
| `target` | A payment id, `pay_` followed by 6 to 40 letters or digits | Yes. Anything else is refused as `invalid_input` |
| `parameters.amount` | A positive whole number of paise (`100` is ₹1) | Yes. Zero, negative, fractional or non-number is refused as `invalid_input` |
| `businessTransactionId` | Parmana's transaction id. It is sent to Razorpay as the refund receipt | Yes. Empty is refused as `invalid_input` |

The connector does not compare the amount with the payment. Razorpay applies its own limits on what can be refunded.

The connector does not check the length of the receipt, so a very long `businessTransactionId` depends on Razorpay accepting it.

## Credential

The credential is one value: `<key id>:<key secret>`.

- The key id must match `rzp_test_` or `rzp_live_`, followed by letters or digits. The secret must not be blank.
- `rzp_live_` keys are refused unless `PARMANA_ALLOW_LIVE_KEYS=true`. The service checks this at startup and again on every call.
- The credential is sent as HTTP Basic authentication, and only to `https://api.razorpay.com`. Redirects are refused, so it cannot reach another host.
- A refused credential is reported without its value. The error text names the expected format, not the key.

## What it does

1. Lists the payment's refunds, 100 at a time, with `GET /v1/payments/{pay_id}/refunds?count=100&skip=N`. It reads pages until it has a match or reaches a short page, and reads at most 10 pages (1,000 refunds).
2. If one of them has `receipt` equal to the `businessTransactionId`, returns that refund with `alreadyRefunded: true`. It creates nothing.
3. Otherwise creates the refund with `POST /v1/payments/{pay_id}/refund`, body `{ amount, speed: "normal", receipt, notes: { parmanaBusinessTransactionId } }`. It returns the new refund with `alreadyRefunded: false`.

The time limit is `PARMANA_CONNECTOR_TIMEOUT_MS` (default 10 s) for the whole release, not for each call. Each call is given what is left of it, so the list and the refund together never run past the limit. No call is retried.

### Limits of the repeat check

- The check reads at most 1,000 refunds on one payment. If the payment has more, the connector refuses with `upstream_error` and creates no refund, because it cannot rule out an earlier one. Check Razorpay's dashboard in that case.
- An earlier refund is returned whatever its `status` is. If an earlier attempt is in a failed state, the repeat returns it and does not try again. Check the status in the answer.
- A list answer without an `items` array is refused. It is not read as "no earlier refund".

## The answer

The service returns the connector's answer as `result.body`:

```json
{
  "refundId": "rfnd_...",
  "paymentId": "pay_...",
  "amount": 100,
  "status": "processed",
  "receipt": "txn-...",
  "alreadyRefunded": false
}
```

- `status` is what Razorpay reports for the refund, for example `pending` or `processed`.
- `receipt` is `null` if Razorpay did not return one.
- `alreadyRefunded` is `true` when the refund already existed for this `businessTransactionId`.
- `result.status` in the service's answer is always `200` for this connector.

## Errors

The connector throws a `ConnectorError`. The service returns only its code, as `connector failed: <code>`.

| Code | When | What the operator should check |
| --- | --- | --- |
| `invalid_input` | A refusal of the request: target, amount or missing `businessTransactionId`. No call was made | The release as sent by parmana-core |
| `credential_invalid` | The key pair is malformed, or a live key is used without `PARMANA_ALLOW_LIVE_KEYS=true`. No call was made | The Vercel or local setting |
| `unknown_capability` | The capability is not `razorpay:refund` | The release's capability |
| `upstream_error` (Razorpay refused) | Razorpay returned an error for the list or the refund. Its code and description are in the connector's message, which the service logs | Razorpay's dashboard |
| `upstream_error` (not reached) | The network call failed | The message says whether a refund may exist. Follow the recovery steps in [RUNBOOK.md](../../../RUNBOOK.md) |
| `timeout` | A call ran out of the time limit | As above |

The message says what the operator must check:

- **No refund was created.** The failure came from the list call, or the refund call never left the service. Nothing needs checking in Razorpay before the release is looked at again.
- **A refund may have been created**, after the refund call was sent and no answer came back. The message names the receipt. Check Razorpay for a refund with that receipt before any other action, using the steps in [RUNBOOK.md](../../../RUNBOOK.md).

The service refuses a resend of the same release, because the replay record already exists. A resend cannot be the way to recover.

## Test-mode run

`src/connectors/razorpay/test-run.mjs` runs the connector against Razorpay's test mode from your own machine. Settings and commands are in the [README](../../../README.md#razorpay-test-mode-run).

It makes one refund, checks that a repeat returns the same refund, and checks two refusals (a target that is not a payment id, and a zero amount). It refuses a key that is not `rzp_test_`, and it never prints the key. Test-mode refunds move no money.

The last recorded run passed 4 of 4 checks on 29 October 2026, as noted in the operator's status notes.

## Not covered yet

- A payment with more than 1,000 refunds is refused, not refunded. Such a payment needs a person to check Razorpay.
- Live keys. Live money is off, and no live run is recorded.
- The paging parameters (`count`, `skip`) are used as Razorpay's API reference describes them. The test-mode run has not yet been repeated against them.
