# parmana-connectors

Vendor connectors for [Parmana](https://github.com/pavancharak/parmana-core), and the service that runs them. Each connector runs outside parmana-core. The service receives a signed release from Parmana, verifies it, performs the action in the business system with the connector's own credentials, and returns the result.

Parmana core decides whether an action may run and records the decision. This repository holds the code that performs the action. It never decides policy, and it never acts on a request that Parmana has not approved.

## Status

| Part | State |
| --- | --- |
| Service: signed-release verification, single-use reservation, health check, graceful shutdown, configuration that refuses to start when unsafe | Built and tested. Not deployed |
| Razorpay connector (`razorpay:refund`) | Built and tested against a fake Razorpay. Run against Razorpay's test mode on 29 October 2026: 4 of 4 checks passed. Not run with live keys |
| Deployment, hosting and secret storage | Not started. Decisions pending |
| Live money | Off. Live keys are refused unless the service is started with `PARMANA_ALLOW_LIVE_KEYS=true` |

## Running the service

```bash
npm ci
npm run build
npm start
```

The service reads its settings from the environment. It refuses to start if a setting is missing or unsafe, and the error names the setting, never its value.

For a local run, copy `.env.example` to `.env` and fill it in. `npm start` reads `.env` when it starts, so the settings persist between shells. `.env` is git-ignored and must never be committed. A hosted service takes the same settings from the host's environment, and a `.env` file is not deployed.

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PARMANA_CONNECTOR` | Yes | none | The connector to run. One of: `razorpay` |
| `RAZORPAY_KEY_PAIR` | Yes, for `razorpay` | none | The Razorpay credential, `<key id>:<key secret>`. Its key id starts with `rzp_test_` or `rzp_live_` |
| `PARMANA_ALLOW_LIVE_KEYS` | No | `false` | Accepts `rzp_live_` keys. Leave unset until a live test has been approved |
| `PARMANA_PUBLIC_KEY` | One of the two | none | Parmana's Ed25519 public key, as PEM text. Literal `\n` sequences are read as line breaks. Releases are refused unless they verify against it |
| `PARMANA_PUBLIC_KEY_FILE` | One of the two | none | Path to Parmana's Ed25519 public key, in PEM. Set this or `PARMANA_PUBLIC_KEY`, never both |
| `PARMANA_RELEASE_AUDIENCE` | Yes | none | This endpoint's URL, exactly as registered in parmana-core. Must be `https://` |
| `PARMANA_NONCE_STORE` | No | `postgres` | `postgres` shares replay protection across instances. `memory` is for one instance and tests |
| `PARMANA_DATABASE_URL` | With `postgres` | none | The database for replay protection. The service creates its table on start |
| `PARMANA_SERVICE_PORT` | No | `8080` | Port to listen on |
| `PARMANA_SERVICE_HOST` | No | `127.0.0.1` | Address to bind. A hosted service needs `0.0.0.0` |
| `PARMANA_CONNECTOR_TIMEOUT_MS` | No | `10000` | Limit for the connector's call, in milliseconds |

Secrets are read from the environment. How they are placed there, whether by the host's settings or a secret manager, is a deployment decision and is not made in this repository.

## What the service checks, in order

For `POST /execute`, a request must pass every check before the connector runs.

1. **Shape.** The body is a signed release, within 256 KB.
2. **Signature.** Ed25519, key id `default`, over the canonical serialization of the release. Any change after signing fails.
3. **Audience.** The release names this endpoint's URL exactly.
4. **Capability.** The connector serves the release's capability.
5. **Expiry.** The release has not expired, allowing 30 seconds of clock difference.
6. **Replay.** The `businessTransactionId` has not run before. It is recorded in the database before the connector runs, so two instances cannot both act on one release.

The replay record is written only after checks 1 to 5 pass, so a release refused for another reason can be sent again with a fresh signature.

A release that passes every check runs the connector once. Its answer is `200` with `success`, `businessTransactionId`, `capability`, `result` and `executedAt`. A connector failure returns `success: false`, with only the error code (for example `connector failed: upstream_error`). The detail stays in the service's log and never reaches the caller.

A release refused by a check returns `403` with the reasons. A body that is not a release returns `400`, a body over the limit returns `413`, and an unknown route returns `404`. If the replay database is unavailable, the service returns `500` and runs nothing.

**Known limit.** A release is recorded before the connector runs. If the process stops after the record and before the connector finishes, that release is refused on every later attempt, and the operator must check the business system by hand. This is the price of acting at most once.

`GET /health` returns `{"status":"UP"}`. It shows that the process is running. It does not check the database or the business system.

## Logs

The service writes one JSON line per event to stdout. A log line never contains a credential, a request body, or an upstream response. Events include `service_started`, `release_refused` (with the number of reasons), `release_answered`, `connector_failed` (with the error code), and `shutdown_started` and `shutdown_complete`.

On SIGTERM or SIGINT, the service stops accepting new connections, lets in-flight requests finish for up to 25 seconds, and then exits.

## Layout

| Path | Contents | Imports |
| --- | --- | --- |
| `src/connector-contract.ts` | The shared contract: request, response, error and connector interface | Nothing |
| `src/connector.ts` | The generic connector, which runs a manifest's HTTP calls. It re-exports the contract | The contract and the manifest engine |
| `src/manifest.ts`, `schema/manifest.schema.json` | Manifest loading and validation | `ajv`, `yaml` |
| `src/connectors/<vendor>/` | One folder per vendor connector | Node built-ins, its own folder, and the contract only |
| `src/service/` | The service: configuration, release verification, replay store, HTTP server, logging, and the registry of connectors | The contract, the connector registry, and `@parmana/crypto` |
| `src/main.ts` | The entry point | The service |
| `tests/` | Tests for connectors, the service, and the import rules | |

## Rules for connectors

These rules keep connectors separate from each other and from the manifest engine. `tests/boundaries.test.ts` checks them.

- A vendor connector imports only Node built-ins (`node:*`), files in its own folder, and `connector-contract.ts`.
- A vendor connector never imports the manifest engine, another vendor's connector, or code from parmana-core.
- `connector-contract.ts` imports nothing. Keep it that way.

## Adding a connector

1. Create `src/connectors/<vendor>/` and write the connector against `src/connector-contract.ts`. Implement `execute(request, context)`, and throw a `ConnectorError` for every refusal, with a message that never contains the credential.
2. Make the connector act once. If the business system can repeat an action, check for an existing result before acting, keyed by the `businessTransactionId`. The Razorpay connector does this with the refund receipt.
3. Refuse anything outside what the capability allows before any call is made: wrong target, wrong amount, wrong credential format.
4. Add its credential to `src/service/registry.ts`: the environment variable, the check, and the factory. The service cannot select a connector without them.
5. Add tests under `tests/connectors/` against a fake of the vendor's API, covering the refusals, the repeat case, and an error from the vendor that does not leak the credential.
6. Run `npm test`. The boundary test must pass.

## Razorpay connector

`src/connectors/razorpay/razorpay-connector.ts` exports `createRazorpayConnector`, which implements `razorpay:refund`.

- **Target:** the payment id, `pay_...`. Anything else is refused.
- **Amount:** `parameters.amount`, a positive whole number of paise.
- **Credential:** `<key id>:<key secret>`, with a key id that starts with `rzp_test_` or `rzp_live_`. It is sent as HTTP Basic authentication.
- **Live keys:** refused unless live keys are allowed. The service checks this at startup and on every call.
- **Receipt:** each refund carries the release's `businessTransactionId` as its receipt. Before refunding, the connector lists the payment's refunds. If one already carries that receipt, it returns that refund and does not refund again.
- **Failures:** a Razorpay error is reported with its code and description, to the service's log only. A network failure is reported as possibly executed, so the operator checks Razorpay before resending.

## Razorpay test-mode run

This checks the connector against Razorpay's test API. Run it on your own machine, with a test key and a captured test payment:

```bash
export RAZORPAY_KEY_PAIR="rzp_test_...:<secret>"
export RAZORPAY_TEST_PAYMENT_ID="pay_..."
npm ci && npm run build
node --env-file-if-exists=.env scripts/razorpay-test-run.mjs
```

It creates one refund of `RAZORPAY_TEST_AMOUNT` paise (default 100), checks that a repeat returns the same refund, and checks two refusals. Test-mode refunds move no money. The script refuses anything that isn't a test key, and it never prints the key.

## Dependencies

`@parmana/crypto` 0.1.0 is used for the canonical serialization that the signature covers. Its dependency `@parmana/shared` 0.1.0 loads `dotenv` at runtime without declaring it, so this repository declares `dotenv` directly. Remove that entry when the upstream package declares its own dependency.

## Commands

```bash
npm ci
npm run build
npm test
npm start
```

Requires Node.js 24 or later.

## License

Apache-2.0, as declared in `package.json`.
