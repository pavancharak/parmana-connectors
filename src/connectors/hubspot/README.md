# HubSpot connector

A connector that lets an AI agent read and update a HubSpot deal's stage and amount, only when a trusted person has signed an approval for that deal. Parmana records each decision in a signed trust record that anyone can verify offline.

> **Status:** Pre-production. The request shapes have not been checked against a live HubSpot portal. See [Known limits](#known-limits).

## Capabilities

| Capability | Policy | What it does |
|---|---|---|
| `hubspot:deal-fetch` | `hubspot-deal-read` (in `parmana-core/policies/`) | Reads the deal's `dealstage`, `amount` and `pipeline`. Read-only. |
| `hubspot:deal-update` | `hubspot-deal-update` 1.1.0 | Sets `dealstage` and/or `amount`, and nothing else. |

- `dealId` must be digits only, and it must equal the release target when the release names one.
- An update needs `dealstage`, `amount`, or both. `dealstage` must be a non-empty string. `amount` must be a finite number.
- Only the parameters listed above are allowed for each capability. Any other is refused before a call.
- An update sets final values, so a repeat leaves the deal in the same state. Nothing is incremented.

A deal update is refused unless:

- A signed approval exists for that deal (`dealUpdateApproved`).
- Any stage change follows an allowed forward path (`dealStageTransitionAllowed`).

## Architecture

```
Agent ──request──► Parmana core (policy, approval, signed decision)
                        │
                        │ signed release (approved action only)
                        ▼
                   parmana-connectors (this connector)
                        │ Private App token (bearer header, never stored)
                        ▼
                   HubSpot API (https://api.hubapi.com) ──► deal
```

- **Code:** `hubspot-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Tests:** `tests/connectors/hubspot/`. They use a fake HubSpot and do not contact HubSpot.

## Requirements

- Node.js 24 or later
- A HubSpot Private App with the deal scopes the connector needs (read for fetch, write for update)
- A test portal for the first run
- Parmana's Ed25519 public key for verifying releases

## Credential

`HUBSPOT_PRIVATE_APP_TOKEN` holds the Private App token. It must not be empty and must not contain spaces. It is sent only as a bearer header. Errors and results show only a fingerprint of it, and the value is never shown.

Create the Private App in HubSpot under Settings → Integrations → Private Apps. Start with a test portal, and grant only the deal scopes you need.

## Configuration

Copy `.env.example` to `.env` for local runs. On a hosted service, set these in the host's environment instead.

| Variable | Value | Notes |
|---|---|---|
| `PARMANA_CONNECTOR` | `hubspot` | One connector per running service |
| `HUBSPOT_PRIVATE_APP_TOKEN` | Private App token | Secret |
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

1. Use a test portal with one disposable deal.
2. Run `hubspot:deal-fetch` on the deal with a signed `hubspot-deal-read` approval, and record its `dealstage` and `amount`.
3. Run `hubspot:deal-update` with a signed `hubspot-deal-update` approval, changing one value.
4. Read the deal again and confirm the change.
5. Restore the original values with a second approved update.
6. Verify the trust records with `parmana-verifier`.

## Policies

- `hubspot-deal-update` 1.1.0 allows an update only with `dealUpdateApproved: true` for that deal. A stage change must also be on an allowed forward path. The policy binds `proposedDealStage` to `parameters.dealstage` and `proposedAmount` to `parameters.amount`, so the approved values must be the ones sent.
- The current stage used for the path check (`currentDealStage`) is supplied by the caller. Confirm how your caller fills it, and read it from HubSpot before the release, because the check is only as good as that value.

Confirm that the policy version is in effect on your instance before you test. See the `/policies/in-effect` endpoint in the API docs.

## Security model

- **Credential isolation.** The token is never returned to the caller, the decision or the evidence.
- **Fail closed.** A malformed credential, an unknown parameter, a bad deal id or a deal id that differs from the target is refused before any call to HubSpot.
- **Replay protection.** Releases are single-use, enforced through the nonce store.
- **Ambiguous outcomes.** If an update may have reached HubSpot but no answer was read, the error tells the operator to check the deal before any other action.

## Known limits

- **Not yet verified live:** the request shapes have not been checked against a live HubSpot portal. Treat the first production run as a test.
- **Caller-supplied stage:** the stage-path check depends on the caller's `currentDealStage`. See Policies above.
- **Direct access:** a HubSpot call made outside Parmana is not checked or recorded.
- **Token exposure:** on a shared host, code that can read the server's environment can read the token. Run the connector on a host you control.

## Operations

- **Rotate the token:** create a new Private App token, update `HUBSPOT_PRIVATE_APP_TOKEN`, redeploy, then revoke the old token in HubSpot.
- **Revoke access:** deactivate or delete the Private App in HubSpot. This stops all calls immediately.
- **Monitor:** review every `upstream_error` that tells you to check the deal.

## Contributing and security

Read `CONTRIBUTING.md` before you open a pull request. Report vulnerabilities privately, as described in `SECURITY.md`. Do not open a public issue for them.
