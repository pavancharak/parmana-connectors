# parmana-connectors

Vendor connectors for [Parmana](https://github.com/pavancharak/parmana-core), and the service that runs them. Each connector runs outside parmana-core. The service receives a signed release from Parmana, verifies it, performs the action in the business system with the connector's own credentials, and returns the result.

Parmana core decides whether an action may run and records the decision. This repository holds the code that performs the action. It never decides policy, and it never acts on a request that Parmana has not approved.

## Why this repository exists

Parmana core decides whether an action is approved, and records that decision. Core does not act in business systems, and it should not hold their credentials. This repository holds the vendor code that performs approved actions, kept apart from core so that:

- core carries no vendor credentials or vendor client code;
- a connector can be changed, deployed or replaced without a core release;
- each connector is tested against its own vendor's API.

## How it is used

1. An agent or application proposes an action to parmana-core.
2. Core evaluates the policy and any required approval. If the action is allowed, core creates a release, signed with Parmana's Ed25519 key. The release names the connector, the capability, the target and amount, an expiry, and this service as its audience.
3. Core sends the release to this service: `POST /api/execute` on Vercel, or `POST /execute` when run locally.
4. The service checks the release (signature, audience, capability, expiry, single use) and runs the connector once, with the connector's own credential.
5. The result goes back to core, which checks it against the signed release.

This service never decides whether an action is allowed. It refuses any release that fails its checks, and it runs one connector per process, chosen by `PARMANA_CONNECTOR`.

## Status

| Part | State |
| --- | --- |
| Service: signed-release verification, single-use reservation, health check, graceful shutdown, configuration that refuses to start when unsafe | Built and tested. Deployed to Vercel production at `https://parmana-connectors.vercel.app`, with no production traffic yet |
| Razorpay connector (`razorpay:refund`) | Built and tested against a fake Razorpay. Run against Razorpay's test mode on 29 October 2026: 4 of 4 checks passed. Not run with live keys. No signed release has yet been run end to end through the deployed service |
| Manifest engine (`src/manifest.ts`, `src/connector.ts`) | Built and covered by unit tests. Not used by any connector in the service yet. See [docs/MANIFEST.md](docs/MANIFEST.md) |
| Deployment, secrets and operations | Vercel production with a Supabase replay database. Setup in [SETUP.md](SETUP.md) and [RUNBOOK.md](RUNBOOK.md). Open items are not listed publicly yet |
| Live money | Off. Live keys are refused unless the service is started with `PARMANA_ALLOW_LIVE_KEYS=true` |
| Migration out of parmana-core (ADR-0018), as of 3 November 2026 | Six connector folders on `main`: Razorpay, Paytm, Slack, GitHub, HubSpot, Zerodha (paper only, no live mode). Removed from parmana-core: Zerodha (#295), Slack (#296), Paytm (#297), GitHub (#299), HubSpot (#300). Registrations in parmana-core still open: Razorpay, GitHub, HubSpot, Slack. Paytm needs none. The status of each registration is listed above, and the steps are in the connector READMEs |

## Documentation

| File | Read it for |
| --- | --- |
| This README | What the repository is, how to run the service, and the layout |
| [docs/API.md](docs/API.md) | The HTTP routes, the signed release, every answer, the limits and the log events |
| [src/connectors/razorpay/README.md](src/connectors/razorpay/README.md) | The `razorpay:refund` capability: request, credential, behaviour, answer, errors |
| [docs/MANIFEST.md](docs/MANIFEST.md) | The manifest format and engine (tested, not used by a connector yet) |
| [SETUP.md](SETUP.md) | The Vercel project and every environment variable |
| [RUNBOOK.md](RUNBOOK.md) | Deploying, verifying, shipping a change, troubleshooting, and recovering a release that was recorded but not confirmed |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branches, sign-off, checks, CI and how to add a connector |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |

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
| `PARMANA_CONNECTOR` | Yes | none | The connector to run. One of: `github`, `hubspot`, `paytm`, `razorpay`, `slack`, `zoho` |
| `ZOHO_ACCESS_TOKEN` | Yes, for `zoho` | none | A Zoho OAuth access token. It is sent only in the `Zoho-oauthtoken` header, and the value is never shown in an error. See [the Zoho README](src/connectors/zoho/README.md) |
| `ZOHO_ORGANIZATION_ID` | Yes, for `zoho` | none | The Zoho Books organization id, digits only. The service refuses to start without it |
| `RAZORPAY_KEY_PAIR` | Yes, for `razorpay` | none | The Razorpay credential, `<key id>:<key secret>`. Its key id starts with `rzp_test_` or `rzp_live_` |
| `SLACK_BOT_TOKEN` | Yes, for `slack` | none | The Slack bot token, `xoxb-...`. It needs the `chat:write` scope. The value is never shown in an error. See [the Slack README](src/connectors/slack/README.md) |
| `GITHUB_APP_CREDENTIAL` | Yes, for `github` | none | `<app id>:<installation id>:<base64 of the App's PEM private key>`. A fresh installation token is minted for each call and never stored. See [the GitHub README](src/connectors/github/README.md) |
| `HUBSPOT_PRIVATE_APP_TOKEN` | Yes, for `hubspot` | none | A HubSpot Private App token. It is sent only as a bearer header, and the value is never shown in an error. See [the HubSpot README](src/connectors/hubspot/README.md) |
| `PAYTM_MERCHANT_CREDENTIAL` | Yes, for `paytm` | none | The Paytm credential, `<merchant id>:<merchant key>`. The key must be exactly 16 bytes. The connector runs against Paytm staging only. See [the Paytm README](src/connectors/paytm/README.md) |
| `PARMANA_ALLOW_LIVE_KEYS` | No | `false` | Accepts `rzp_live_` keys. Leave unset until a live test has been approved. Must be `true` or `false` |
| `PARMANA_PUBLIC_KEY` | One of the two | none | Parmana's Ed25519 public key, as PEM text. Literal `\n` sequences are read as line breaks. Releases are refused unless they verify against it |
| `PARMANA_PUBLIC_KEY_FILE` | One of the two | none | Path to Parmana's Ed25519 public key, in PEM. Set this or `PARMANA_PUBLIC_KEY`, never both |
| `PARMANA_RELEASE_AUDIENCE` | Yes | none | This endpoint's URL, exactly as registered in parmana-core. Must be `https://` |
| `PARMANA_NONCE_STORE` | No | `postgres` | `postgres` shares replay protection across instances. `memory` is for one instance and tests |
| `PARMANA_DATABASE_URL` | With `postgres` | none | The database for replay protection. The service creates its table on start |
| `PARMANA_SERVICE_PORT` | No | `8080` | Port to listen on. An integer from 1 to 65535 |
| `PARMANA_SERVICE_HOST` | No | `127.0.0.1` | Address to bind. A hosted service needs `0.0.0.0` |
| `PARMANA_CONNECTOR_TIMEOUT_MS` | No | `10000` | Time limit for a connector call, in milliseconds (100 to 120000). For the Razorpay connector it is the total for all of its calls for one release. See [the Razorpay README](src/connectors/razorpay/README.md) |

Secrets are read from the environment. How they are placed there, whether by the host's settings or a secret manager, is a deployment decision and is not made in this repository.

## What the service checks

For `POST /execute`, a release must pass every check before the connector runs: the body's shape, the Ed25519 signature, the audience, the capability, the expiry (with 30 seconds of clock difference allowed), and then replay. The replay record is written only after the other checks pass, and before the connector runs. So a release refused for another reason can be sent again with a fresh signature, and two instances cannot both act on one release.

A release that passes runs the connector once. A refused release returns `403` with every reason found, and nothing runs. The full list of checks, answers, status codes and limits is in [docs/API.md](docs/API.md).

**Known limit.** A release is recorded before the connector runs. If the process stops after the record and before the connector finishes, that release is refused on every later attempt, and the operator must check the business system by hand. This is the price of acting at most once. [RUNBOOK.md](RUNBOOK.md) has the steps.

`GET /health` returns `{"status":"UP"}`. It shows that the process is running. It does not check the database or the business system.

## Logs

The service writes one JSON line per event to stdout. A log line never contains a credential or a request body. A failed connector call is logged with its error code and the connector's own message, capped at 300 characters. That message never holds the credential, and for Razorpay it carries Razorpay's error description. The events are listed in [docs/API.md](docs/API.md#logs).

On SIGTERM or SIGINT, the service stops accepting new connections, lets in-flight requests finish for up to 25 seconds, and then exits.

## Deployment on Vercel

The production service is a set of Vercel functions:

- `api/execute.ts` serves `POST /api/execute`.
- `api/health.ts` serves `GET /api/health`.

The Vercel adapter strips the `/api` prefix and passes the request to the same handler the local service uses. It reads the settings on its first request, not at build time. A missing or invalid setting returns `500` with `{"error":"service is not configured"}`, and the reason is written to the log as `service_not_configured`. Settings are read from the Vercel environment, which is set as described in [SETUP.md](SETUP.md). The build is not run on Vercel: `public/` holds a placeholder page, and the functions are compiled from `api/`.

## Layout

| Path | Contents | Imports |
| --- | --- | --- |
| `src/connector-contract.ts` | The shared contract: request, response, error and connector interface | Nothing |
| `src/connector.ts` | The generic connector, which runs a manifest's HTTP calls. It re-exports the contract. Tested, not used by a connector yet | The contract and the manifest engine |
| `src/manifest.ts`, `schema/manifest.schema.json` | Manifest loading and validation. Tested, not used by a connector yet | `ajv`, `yaml` |
| `src/connectors/<vendor>/` | One folder per vendor: its code, its README, and any check script. Its unit test is in `tests/connectors/<vendor>/`, because the boundary test does not allow a vendor folder to import vitest | Node built-ins, its own folder, and the contract only |
| `src/service/` | The service: configuration, release verification, replay store, HTTP server, logging, and the registry of connectors | The contract, the connector registry, and `@parmana/crypto` |
| `src/main.ts` | The entry point for the local service | The service |
| `api/execute.ts`, `api/health.ts` | The Vercel functions | The service |
| `public/index.html` | The placeholder page at the site root | Nothing |
| `src/connectors/razorpay/test-run.mjs` | The Razorpay test-mode check. Uses the built `dist/` | The built Razorpay connector |
| `tests/` | Tests for connectors, the service, the Vercel adapter, and the import rules. The PostgreSQL tests are skipped unless `PARMANA_TEST_DATABASE_URL` is set | |
| `docs/` | The API and manifest references. Connector references live in each connector's folder | |
| `.github/` | CI, CodeQL, DCO, dependency review, Dependabot and code owners | |

## Rules for connectors

These rules keep connectors separate from each other and from the manifest engine. `tests/boundaries.test.ts` checks them.

- A vendor connector imports only Node built-ins (`node:*`), files in its own folder, and `connector-contract.ts`.
- A vendor connector never imports the manifest engine, another vendor's connector, or code from parmana-core.
- `connector-contract.ts` imports nothing. Keep it that way.

## Adding a connector

1. Create `src/connectors/<vendor>/` and write the connector against `src/connector-contract.ts`. Implement `execute(request, context)`, and throw a `ConnectorError` for every refusal, with a message that never contains the credential.
2. Make the connector act once. If the business system can repeat an action, check for an existing result before acting, keyed by the `businessTransactionId`. The Razorpay connector does this with the refund receipt.
3. Refuse anything outside what the capability allows before any call is made: wrong target, wrong amount, wrong credential format.
4. Add its credential to `src/service/registry.ts`: the environment variable, the check, the factory, and a case in each switch. The service cannot select a connector without them.
5. Add the connector's variable to `.env.example`, to the table in this README, and to [SETUP.md](SETUP.md). Add it to the Vercel environment as described in [RUNBOOK.md](RUNBOOK.md).
6. Add tests under `tests/connectors/<vendor>/` against a fake of the vendor's API, covering the refusals, the repeat case, and an error from the vendor that does not leak the credential.
7. Document the connector in `src/connectors/<vendor>/README.md`, the way [the Razorpay README](src/connectors/razorpay/README.md) does.
8. Run `npm test`. The boundary test must pass.

## Razorpay connector

`src/connectors/razorpay/razorpay-connector.ts` exports `createRazorpayConnector`, which implements `razorpay:refund`. It refunds a payment once: each refund carries the release's `businessTransactionId` as its receipt, and a repeat returns the existing refund instead of creating another. Refusals happen before any call to Razorpay, live keys are refused unless allowed, and the caller receives only the error code. The connector reads up to 1,000 refunds to look for an earlier one, and refuses rather than guess beyond that. A failure after a refund may have been sent says to check Razorpay before any other action. The full behaviour, its limits, the answer and the error codes are in [its README](src/connectors/razorpay/README.md).

## Razorpay test-mode run

This checks the connector against Razorpay's test API. Run it on your own machine, with a test key and a captured test payment:

```bash
export RAZORPAY_KEY_PAIR="rzp_test_...:<secret>"
export RAZORPAY_TEST_PAYMENT_ID="pay_..."
npm ci && npm run build
node --env-file-if-exists=.env src/connectors/razorpay/test-run.mjs
```

It creates one refund of `RAZORPAY_TEST_AMOUNT` paise (default 100), checks that a repeat returns the same refund, and checks two refusals. Test-mode refunds move no money. The script refuses anything that isn't a test key, and it never prints the key. `RAZORPAY_TEST_PAYMENT_ID` and `RAZORPAY_TEST_AMOUNT` are described in `.env.example`.

## Dependencies

`@parmana/crypto` 0.1.0 is used for the canonical serialization that the signature covers. Its dependency `@parmana/shared` 0.1.0 loads `dotenv` at runtime without declaring it, so this repository declares `dotenv` directly. Remove that entry when the upstream package declares its own dependency.

## Commands

```bash
npm ci
npm run build
npm run typecheck
npm test
npm start
```

| Command | What it does |
| --- | --- |
| `npm run build` | Compiles to `dist/`. Required before `npm start` and the Razorpay test-mode run |
| `npm run typecheck` | Type-checks without writing output |
| `npm test` | Runs the Vitest suite. Tests that need PostgreSQL run only when `PARMANA_TEST_DATABASE_URL` is set |
| `npm start` | Runs `dist/main.js`, reading `.env` if it exists |

Requires Node.js 24 or later. CI runs Node 24.

## Continuous integration

The workflows run as listed below. The details are in [CONTRIBUTING.md](CONTRIBUTING.md).

- **CI** (pushes to `main` and pull requests): builds and tests on Node 24, with a throwaway PostgreSQL 16 for the replay-store tests.
- **CodeQL** (pushes to `main`, pull requests into `main`, and weekly): analyses the TypeScript code.
- **DCO** (pull requests into `main`): every commit needs a `Signed-off-by` line.
- **Dependency review** (pull requests into `main`): flags newly added dependencies with known vulnerabilities.

## License

Apache-2.0. The licence text is in [LICENSE](LICENSE), and `package.json` declares the same licence.
