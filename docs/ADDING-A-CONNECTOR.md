# Adding a connector

This is the procedure for a new vendor in `parmana-connectors`. Follow it in order. Each step says what to do and where to look. Where the procedure needs a decision, it says who makes it.

Two worked examples exist: the [Razorpay connector](../src/connectors/razorpay/README.md) (an action connector, with a signal source) and the [Zoho Books connector](../src/connectors/zoho/README.md) (an action connector, with a documented open-item list).

## 0. Decide what you are building

There are two kinds of component. Pick one before you start.

| Kind | What it does | Where it lives | Example |
| --- | --- | --- | --- |
| **Action connector** | Performs an approved action in an institutional system (refund, create invoice, post a message). Runs only on a signed release from parmana-core. | `src/connectors/<vendor>/`, registered in `src/service/registry.ts` | `payments:refund`, `zoho:invoice-create` |
| **Signal source** | Answers a read-only question that a policy needs (for example, is this payment refundable?). Answers signed queries from parmana-core. | `src/signal/`, plus the policy that uses it in parmana-core | `payment.refundable` |

Most new vendors need an action connector. A signal source is needed only when a policy must check a fact in that vendor's system.

**Limit today:** the signal service in `src/signal/service.ts` calls the Razorpay signal directly. It does not yet dispatch to a second signal by claim. A second signal source therefore also needs a change to that dispatch, which is a separate piece of work. Raise it with the owner before you start.

## 1. Name things

Use these names exactly. The service and parmana-core match on them.

| Thing | Rule | Example |
| --- | --- | --- |
| Vendor name (folder and `PARMANA_CONNECTOR` value) | lower-case, one word | `zoho` |
| Capability | `<vendor>:<action>`, lower-case, action in kebab-case | `zoho:invoice-create` |
| Claim (signal source) | `<domain>.<fact>` | `payment.refundable` |
| Environment variable | upper-case, vendor prefix | `ZOHO_ACCESS_TOKEN` |
| Connector id in a release | `ext-` followed by the capability. parmana-core signs this. | `ext-zoho:invoice-create` |

## 2. Write the connector (action connectors)

1. Create `src/connectors/<vendor>/`. The folder may import only Node built-ins, its own files, and `src/connector-contract.ts`. `tests/boundaries.test.ts` enforces this.
2. Implement `execute(request, context)` against `src/connector-contract.ts`. Throw `ConnectorError` for every refusal. A message must never contain the credential.
3. Act once. If the vendor can repeat an action, check for an existing result before acting. Key it by `businessTransactionId`. Razorpay does this with the refund receipt; Zoho writes `businessTransactionId` to `reference_number`.
4. Refuse anything outside what the capability allows, before any call: the target, the parameters, the credential format.
5. Write `src/connectors/<vendor>/README.md` covering the capability, configuration, idempotency, a test run, known limits, and open items. The Zoho README is the model.

## 3. Register it in the service

Four places in `src/service/registry.ts` must all change:

1. `CONNECTOR_NAMES`: add the vendor name.
2. `credentialVariableFor`: return its environment variable.
3. `assertCredentialUsable`: check the credential format, and refuse a live key unless `allowLiveKeys` is set.
4. `createConnector`: return the connector.

`src/service/config.ts` reads `PARMANA_CONNECTOR` against `CONNECTOR_NAMES`, so it needs no change. The service refuses to start with a missing or malformed credential.

## 4. Document the settings

1. Add the variable to `.env.example`.
2. Add it to the table in the [root README](../README.md), with its value and when it is needed.
3. Add it to [SETUP.md](../SETUP.md), in the same table format, with where its value comes from.

## 5. Test it

1. Add tests under `tests/connectors/<vendor>/`, against a fake of the vendor's API. Cover each refusal, the repeat case, and a vendor error that does not leak the credential.
2. For a signal source, add tests under `tests/signal/`.
3. Run `npm test`. The boundary test must pass.
4. Run the vendor's test-mode check if it has one. Record the result in the connector's README. Do not record a run you did not see.

## 6. Set up parmana-core (a separate change, in `parmana-core`)

A connector cannot receive releases until parmana-core approves its capability. Each of these is a maker-checker change in parmana-core, not a code change.

1. **Write the policy** that governs the capability, and test it with the policy package's tests. See [the production integration guide](https://github.com/pavancharak/parmana-core/blob/main/docs/guides/production-integration-guide.md), steps 1 to 3.
2. **Register the capability**: its name, the endpoint URL, the policy, and the parameters the endpoint may receive. See [the maker-checker chapter, section 6](https://github.com/pavancharak/parmana-core/blob/main/docs/guides/maker-checker-chapter.md#6-capabilities-external-connectors).
3. **Register any signal source** the policy needs, through maker-checker. See step 5 of the integration guide.
4. **Grant the caller** authority for the capability, with a per-request maximum and an expiry. See step 7 of the integration guide.

The connector's endpoint must verify parmana-core's signature and check the audience. The release's audience is the endpoint URL registered in step 2.

## 7. Deploy

1. **Merging to `main` deploys to Vercel production** (see [CONTRIBUTING.md](../CONTRIBUTING.md)). Read [RUNBOOK.md](../src/connectors/razorpay/RUNBOOK.md) for the deployment steps and recovery. Those steps are written for Razorpay, but the process is the same for any connector.
2. Set the vendor's variables in the Vercel environment before the deployment that uses them.
3. Keep `PARMANA_ALLOW_LIVE_KEYS` off, and keep the vendor's key a test key, until the owner approves live use in writing.
4. Make the first live release a limited trial, under an explicit decision.

## 8. Before you merge

- [ ] `src/connectors/<vendor>/` follows the import rules, and `tests/boundaries.test.ts` passes.
- [ ] The four places in `registry.ts` are changed.
- [ ] `.env.example`, the root README and SETUP.md are updated.
- [ ] Tests cover refusals, the repeat case and credential leakage.
- [ ] The connector README lists its open items, with each finding named.
- [ ] The core-side steps (section 6) are done, or the PR says which are still open.
- [ ] A second reviewer who is not the author has read the PR. A new connector is a security change.
