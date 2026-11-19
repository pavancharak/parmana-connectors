# Zoho connector

A connector that lets an AI agent read a Zoho Books invoice, and create one for an approved customer. Parmana records each decision in a signed trust record that anyone can verify offline.

> **Status:** Pre-production. The request shapes have not been checked against a live Zoho Books organization. See [Known limits](#known-limits).

## Capabilities

| Capability | Policy | What it does |
|---|---|---|
| `zoho:invoice-fetch` | Not yet written. Your policy must govern it | Reads one invoice by id. Read-only. |
| `zoho:invoice-create` | Not yet written. Your policy must govern it | Creates one invoice for a customer, with line items. |

- `invoiceId` and `customerId` must be digits only.
- `invoiceId` must equal the release target when the release names one.
- A create needs `customerId` and `lineItems`. `lineItems` is a list of 1 to 50 items, each with a `name` (non-empty, at most 200 characters), a `rate` (a finite number, zero or more) and a `quantity` (a finite number above zero).
- Only the parameters listed above are allowed for each capability. Any other is refused before a call.

## Idempotency

Zoho has no idempotency key, so a create is written with the Parmana `businessTransactionId` as its `reference_number`. A create without a `businessTransactionId` is refused before any call.

If a create may have reached Zoho but no answer was read, the error tells the operator to check for an invoice with that reference number before any other action. Retrying blindly can create a second invoice.

A fetch never changes anything, so a repeat is safe.

## Architecture

```
Agent ──request──► Parmana core (policy, approval, signed decision)
                        │
                        │ signed release (approved action only)
                        ▼
                   parmana-connectors (this connector)
                        │ OAuth access token (Zoho-oauthtoken header, never stored)
                        ▼
                   Zoho Books API (https://www.zohoapis.in/books/v3) ──► invoice
```

- **Code:** `zoho-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Tests:** `tests/connectors/zoho/`. They use a fake Zoho Books and do not contact Zoho.

## Requirements

- Node.js 24 or later
- A Zoho Books organization, with its organization id
- An OAuth access token with the Zoho Books invoice scopes the connector needs (read for fetch, create for create)
- A test organization for the first run
- Parmana's Ed25519 public key for verifying releases

## Credential and organization

`ZOHO_ACCESS_TOKEN` holds the OAuth access token. It must not be empty and must not contain spaces. It is sent only in the `Authorization: Zoho-oauthtoken` header. Errors and results show only a fingerprint of it, and the value is never shown.

`ZOHO_ORGANIZATION_ID` holds the Zoho Books organization id, digits only. Every call is scoped to it. The service refuses to start without it.

Create the token in the Zoho API console. Grant only the invoice scopes you need, and start with a test organization.

## Configuration

Copy `.env.example` to `.env` for local runs. On a hosted service, set these in the host's environment instead.

| Variable | Value | Notes |
|---|---|---|
| `PARMANA_CONNECTOR` | `zoho` | One connector per running service |
| `ZOHO_ACCESS_TOKEN` | OAuth access token | Secret |
| `ZOHO_ORGANIZATION_ID` | Zoho Books organization id, digits only | Required |
| `PARMANA_PUBLIC_KEY` or `PARMANA_PUBLIC_KEY_FILE` | Ed25519 public key | Set one, never both |
| `PARMANA_RELEASE_AUDIENCE` | The endpoint URL, exactly as registered in `parmana-core` | Must be `https` |
| `PARMANA_RELEASE_LEDGER` | `postgres` | Required for more than one instance |
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

1. Use a test organization with one disposable customer.
2. Run `zoho:invoice-create` with a signed approval and a unique `businessTransactionId`. Record the invoice id it returns.
3. Run `zoho:invoice-fetch` on that invoice and confirm its `reference_number` equals the transaction id.
4. Repeat step 2 with the same approval. Confirm that the connector refuses it, because the release is single-use.
5. Verify the trust records with `parmana-verifier`.
6. Delete the test invoice in Zoho Books.

## Policies and integration with parmana-core

No policy for these capabilities ships in this repository. As of 19 November 2026, parmana-core has no policy and no registration for `zoho:invoice-fetch` or `zoho:invoice-create`. Neither capability can be used through parmana-core until both exist. Writing the policy is a parmana-core change. It should bind the approved `customerId` and line items to the parameters sent, so the values that were approved are the values created.

How a release reaches this connector, as [docs/API.md](../../../docs/API.md) describes for every connector:

- `connectorId` must be `ext-` followed by the capability: `ext-zoho:invoice-fetch` or `ext-zoho:invoice-create`.
- `audience` must be the endpoint URL registered for this service, exactly as set in `PARMANA_RELEASE_AUDIENCE`.
- `capability` must be one of the two capabilities above. The service refuses any other.
- `target` is the invoice id for a fetch. A create has no target check (see the open item F28-4 below).

The registration steps in parmana-core, and the Zoho endpoint's registered URL, are not yet recorded in either repository.

## Security model

- **Credential isolation.** The token is never returned to the caller, the decision or the evidence.
- **Fail closed.** A malformed credential, an unknown parameter, a bad id, or a line item the connector cannot send is refused before any call to Zoho.
- **Replay protection.** Releases are single-use, enforced through the nonce store.
- **Ambiguous outcomes.** If a create may have reached Zoho, the error tells the operator to check for the reference number before retrying.
- **Zoho error codes.** Zoho can answer HTTP 200 with a non-zero code. The connector treats that as a refusal, not a success.

## Known limits

- **Not yet verified live:** the request shapes have not been checked against a live Zoho Books organization. Treat the first production run as a test.
- **India data centre only:** the base URL is `https://www.zohoapis.in/books/v3`, for an organization in Zoho's India data centre. Organizations in other Zoho data centres need a code change to the base URL.
- **No duplicate check:** the connector does not search for an existing invoice before a create. Duplicate prevention relies on the `reference_number` and the operator's check. Governance finding F26-6 records this as an open design note.
- **Create does not check the release target (F28-4, open):** `zoho:invoice-create` never reads the release `target`. A signed release whose target names one object can create an invoice for the customer in its parameters. The signature covers both fields, so this is a binding gap, not a forgery. It is open, with no fix branch.
- **Direct access:** a Zoho call made outside Parmana is not checked or recorded.
- **Token exposure:** on a shared host, code that can read the server's environment can read the token. Run the connector on a host you control.

## Not done or not verified

- **Live Zoho Books:** the request shapes have not been checked against a live Zoho Books organization. The first production run is a test. No test organization has been confirmed for this connector yet.
- **Zoho policy and registration:** neither exists in `parmana-core`. Both must exist before any release.
- **Target binding (F28-4, open):** `zoho:invoice-create` does not check the release target. Fix: decide what the target must equal for a create, then check it before the call. Not yet decided.
- **Duplicate check (F26-6, open):** there is no duplicate check before create. The `reference_number` check and the release ledger are the only protection against a second invoice, and the first relies on the operator.

## Operations

- **Rotate the token:** create a new access token, update `ZOHO_ACCESS_TOKEN`, redeploy, then revoke the old token in Zoho.
- **Revoke access:** revoke the token in the Zoho API console. This stops all calls immediately.
- **Monitor:** review every `upstream_error` that tells you to check for a reference number.

## Contributing and security

Read `CONTRIBUTING.md` before you open a pull request. Report vulnerabilities privately, as described in `SECURITY.md`. Do not open a public issue for them.
