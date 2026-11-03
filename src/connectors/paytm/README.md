# Paytm refund connector

A connector that refunds one already-charged Paytm transaction, once. The refund is sent only after Paytm confirms it has no earlier refund for the same reference, and only when a trusted person has signed an approval for that refund. Parmana records each decision in a signed trust record that anyone can verify offline.

> **Status:** Pre-production and staging only. The request and response shapes have not been checked against a live Paytm account. See [Known limits](#known-limits).

## Capability

| Capability | Policy | What it does |
|---|---|---|
| `paytm:refund` | Not yet identified in `parmana-core/policies/`. See Policies. | Refunds one transaction, once. |

## How a refund runs

1. **Validate.** The connector checks the parameters and the credential before any network call. A refused request makes no call.
2. **Check for an earlier refund.** It asks Paytm for the status of the refund reference (`/v2/refund/status`). A read-only call, so a timeout here changes nothing.
   - If Paytm confirms a refund for this reference, that refund is returned with `reused: true`. Nothing is sent.
   - If Paytm reports `PENDING`, the connector refuses and sends nothing. Check Paytm before any other action.
3. **Refund.** Otherwise it sends the refund (`/refund/apply`) with the reference as `refId`.
4. **Confirm.** Only `S`, `SUCCESS` and `TXN_SUCCESS` count as success. `PENDING` is never reported as success.

## Parameters

| Parameter | Required | Rules |
|---|---|---|
| `orderId` | Yes | Sent with the status and refund calls |
| `transactionId` | Yes | The Paytm transaction being refunded |
| `amount` | Yes | A positive number of rupees, at most two decimal places. Sent with two decimals. |
| `refundReason` | No | A string of at most 256 characters. Blank values are dropped. |
| `refundReference` | No | A non-empty string of at most 128 characters. Used as the `refId`. |

The `refId` is `refundReference` if given, otherwise the release's `businessTransactionId`. One of the two must be present. Any other parameter is refused before a call.

## Architecture

```
Agent ──request──► Parmana core (policy, approval, signed decision)
                        │
                        │ signed release (approved action only)
                        ▼
                   parmana-connectors (this connector)
                        │ merchant key, sent to Paytm (never stored)
                        ▼
                   Paytm API (staging by default)
```

- **Code:** `paytm-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Tests:** `tests/connectors/paytm/`. They use a fake Paytm and do not contact Paytm.

## Environments

- **Staging** (`https://securestage.paytmpayments.com`) is the default.
- **Production** (`https://secure.paytmpayments.com`) is refused unless the connector is started with `allowProduction` set to true. This is a separate decision from `PARMANA_ALLOW_LIVE_KEYS`, and it needs its own approval.

Use staging credentials and a staging account until production use is approved.

## Credential

`PAYTM_MERCHANT_CREDENTIAL` holds `<merchant id>:<merchant key>`. The merchant id must not be empty. The key must be exactly 16 bytes. The value is never shown in an error.

## Configuration

Copy `.env.example` to `.env` for local runs. On a hosted service, set these in the host's environment instead.

| Variable | Value | Notes |
|---|---|---|
| `PARMANA_CONNECTOR` | `paytm` | One connector per running service |
| `PAYTM_MERCHANT_CREDENTIAL` | `<merchant id>:<merchant key>` | Secret. Staging only until production is approved. |
| `PARMANA_PUBLIC_KEY` or `PARMANA_PUBLIC_KEY_FILE` | Ed25519 public key | Set one, never both |
| `PARMANA_RELEASE_AUDIENCE` | The endpoint URL, exactly as registered in `parmana-core` | Must be `https` |
| `PARMANA_NONCE_STORE` | `postgres` | Required for more than one instance |
| `PARMANA_DATABASE_URL` | Postgres connection string | Secret |
| `PARMANA_ALLOW_LIVE_KEYS` | `false` | Keep `false` until live use is approved |
| `PARMANA_CONNECTOR_TIMEOUT_MS` | `10000` | Default |

## Running

Locally:

```bash
npm ci
npm test
npm start
```

Hosted: set the variables above in the host's environment and deploy. Environment changes apply to new deployments only, so redeploy after every change. Do not deploy a `.env` file.

## Test run

1. Use a staging account and a transaction you can refund there.
2. Send one refund with a unique `refundReference`. Record the result.
3. Send the same release again. The connector should return the existing refund with `reused: true`, not a second refund.
4. Check the refund in the Paytm staging dashboard.
5. Verify the trust records with `parmana-verifier`.

## Policies

No Paytm refund policy is listed in `parmana-core/policies/` at the commit I checked. Before a live run, identify the policy that binds `paytm:refund`, confirm its version is in effect, and record it here. Do not treat a refund as authorized until that policy is in place.

## Security model

- **Credential isolation.** The merchant key is never returned to the caller, the decision or the evidence.
- **Act once.** The status check runs before every refund, so a resend of an already-refunded reference returns the earlier refund.
- **Fail closed.** A malformed credential, an invalid amount, an over-long field or an unknown parameter is refused before any call.
- **Production gate.** The connector refuses production unless `allowProduction` is set.
- **Replay protection.** Releases are single-use, enforced through the nonce store.

## Known limits

- **Not yet verified live:** the request and response shapes come from the earlier in-core connector and have not been checked against a live Paytm account.
- **Pending refunds:** a refund Paytm reports as `PENDING` is refused, not retried. A person must check Paytm and decide.
- **Ambiguous outcomes:** if a refund may have reached Paytm but no answer was read, the error tells the operator to check Paytm for that reference before any other action.
- **Policy not identified:** see Policies above.

## Operations

- **Rotate the merchant key:** generate a new key in the Paytm dashboard, update `PAYTM_MERCHANT_CREDENTIAL`, redeploy, then retire the old key.
- **Revoke access:** disable the merchant key in the Paytm dashboard. This stops all calls immediately.
- **Monitor:** review every `upstream_error` that says to check Paytm. Each one needs a manual check before anything else happens.

## Contributing and security

Read `CONTRIBUTING.md` before you open a pull request. Report vulnerabilities privately, as described in `SECURITY.md`. Do not open a public issue for them.
