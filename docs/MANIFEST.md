# Manifest engine

The manifest engine turns a description of a vendor's HTTP API into a connector. It is in `src/manifest.ts`, `src/connector.ts`, and the schema at `schema/manifest.schema.json`.

## Status

**Not in use.** The service's registry (`src/service/registry.ts`) runs only the Razorpay connector, and nothing else imports `createGenericConnector`. No test runs a manifest through the engine. The only test that touches it is the boundary test, which enforces that vendor connectors do not import it (see the README's [rules for connectors](../README.md#rules-for-connectors)).

Treat the engine as unproven until a connector uses it and a test covers it.

## What a manifest describes

A manifest is YAML or JSON. It is read with `loadManifest`, or checked as an object with `validateManifest`. YAML aliases and duplicate keys are refused, so one manifest has one meaning.

| Field | Type | Rule |
| --- | --- | --- |
| `system` | string | Lowercase letters, digits and hyphens. 2 to 41 characters. Starts with a letter |
| `baseUrl` | string | Absolute `https://` URL. No credentials, query or fragment. Trailing slash allowed |
| `apiVersion` | string | 1 to 64 characters. Recorded in the manifest, not sent by the engine |
| `credential.type` | `bearer` or `header` | `bearer` sends `Authorization: Bearer <value>`. `header` sends the value in `credential.headerName` |
| `credential.headerName` | string | Required when `type` is `header`. A plain header name, up to 64 characters |
| `credential.secretRef` | string | An uppercase environment-style name, for example `EXAMPLE_API_KEY`. Named in errors, never its value |
| `capabilities` | array | 1 to 200 entries |

Each capability:

| Field | Rule |
| --- | --- |
| `id` | `<system>:<name>`, lowercase. Unique within the manifest |
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | Starts with `/`. No query or fragment. Up to 512 characters. May contain `{name}` placeholders |
| `effect` | `read` or `write`. A `GET` cannot be a `write` |
| `input` | Up to 50 inputs. Each has a `type` (`string`, `number`, `integer`, `boolean`, `object` or `array`) and an optional `required` flag |

Further rules: a `write` capability must declare at least one input, and every `{name}` in a path must be a declared, required input.

## How it runs a call

`createGenericConnector(manifest, options)` validates the manifest first. An invalid manifest throws `invalid_input` before any network call.

When a capability runs:

1. Every input the caller sends must be declared, and each must match its type. A missing required input is refused. The call is refused before any request is built.
2. The credential must be a non-empty string. Its value is used, but never named in an error.
3. The request is built. `{name}` placeholders are filled from the inputs, URL-encoded. For `POST`, `PUT` and `PATCH` the other inputs go in a JSON body. For other methods they go in the query string.
4. The request is sent with the service's timeout (`PARMANA_CONNECTOR_TIMEOUT_MS`, or the engine's default of 10 seconds). Redirects are refused, so the credential cannot reach another host.
5. A non-2xx response is an `upstream_error` that names the capability and the status. The body is not returned in the error.
6. A response body is read up to 1,000,000 bytes by default. Larger bodies are refused. A body with a JSON content type is parsed, and unparseable JSON is an error.

Failures use the codes in `ConnectorErrorCode`: `unknown_capability`, `invalid_input`, `credential_invalid`, `upstream_error`, `timeout`.

## Before a manifest is used

- Add a test under `tests/connectors/` that runs the manifest against a fake of the vendor's API. Cover a refusal, a success, a redirect refusal and a credential that does not leak into an error.
- Make sure the connector that uses it follows the boundary rules (its own folder, Node built-ins, and the contract only). The engine cannot be imported by a vendor connector.
- Register the connector in `src/service/registry.ts`. Until then the service cannot select it.
