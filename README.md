# parmana-connectors

Vendor connectors for [Parmana](https://github.com/pavancharak/parmana-core). Each connector runs outside parmana-core, as its own endpoint. It receives a signed release from Parmana, verifies it, performs the action in the business system with its own credentials, and returns the result.

Parmana core decides whether an action may run and records the decision. This repository holds the code that performs the action. It never decides policy, and it never receives a request that Parmana has not approved.

## Status

This repository holds connector modules and their tests. It does not yet contain a deployable service for them.

| Connector | Capability | Status |
| --- | --- | --- |
| Razorpay | `razorpay:refund` | Module and tests done. Not yet deployed. Test mode by default; live keys are refused unless the caller allows them. |

The release check for signed releases, the endpoint that receives them, and the deployment settings are not in this repository yet. They are the next step.

## Layout

| Path | Contents | Imports |
| --- | --- | --- |
| `src/connector-contract.ts` | The shared contract: request, response, error and connector interface | Nothing |
| `src/connector.ts` | The generic connector, which runs a manifest's HTTP calls. It re-exports the contract | The contract and the manifest engine |
| `src/manifest.ts`, `schema/manifest.schema.json` | Manifest loading and validation | `ajv`, `yaml` |
| `src/connectors/<vendor>/` | One folder per vendor connector | Node built-ins, its own folder, and the contract only |
| `tests/connectors/` | Tests for each vendor connector, against a fake of the vendor's API | |
| `tests/boundaries.test.ts` | Fails if a connector breaks the import rules below | |

## Rules for connectors

These rules keep connectors separate from each other and from the manifest engine.

- A vendor connector imports only Node built-ins (`node:*`), files in its own folder, and `connector-contract.ts`.
- A vendor connector never imports the manifest engine, another vendor's connector, or code from parmana-core.
- `connector-contract.ts` imports nothing. Keep it that way.
- `tests/boundaries.test.ts` checks these rules. A change that breaks them fails the test.

## Adding a connector

1. Create `src/connectors/<vendor>/` and write the connector against the contract in `src/connector-contract.ts`. Implement `execute(request, context)`, and throw a `ConnectorError` for every refusal, with a message that never contains the credential.
2. Make the connector act once. If the business system can repeat an action, check for an existing result before acting, using the `businessTransactionId` as the key. The Razorpay connector does this with the refund receipt.
3. Refuse anything outside what the capability allows before any call is made: wrong target, wrong amount, wrong credential format.
4. Add tests under `tests/connectors/` against a fake of the vendor's API. Cover the refusals, the repeat case, and an error from the vendor that does not leak the credential.
5. Run `npm test`. The boundary test must pass.

## Razorpay connector

`src/connectors/razorpay/razorpay-connector.ts` exports `createRazorpayConnector`, which implements `razorpay:refund`.

- **Target:** the payment id, `pay_...`. Anything else is refused.
- **Amount:** `parameters.amount`, a positive whole number of paise.
- **Credential:** one value, `<key id>:<key secret>`, with a key id that starts with `rzp_test_` or `rzp_live_`. The connector sends it as HTTP Basic authentication.
- **Live keys:** refused unless `allowLiveKeys` is set to `true` when the connector is created.
- **Receipt:** each refund carries the release's `businessTransactionId` as its receipt. Before refunding, the connector lists the payment's refunds. If one already carries that receipt, it returns that refund and does not refund again.
- **Failures:** a Razorpay error is reported with its code and description. A network failure is reported as possibly executed, so the caller resends the same release rather than refunding by hand.

## Commands

```bash
npm ci
npm run build
npm test
```

Requires Node.js 24 or later.

## License

Apache-2.0, as declared in `package.json`.
