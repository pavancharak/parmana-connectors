# HTTP API and release contract

This is the contract between parmana-core and a connector endpoint. It covers the routes, the signed release that parmana-core sends, the answers, and the limits. The code it describes is in `src/service/server.ts`, `src/service/release.ts` and `api/execute.ts`.

## Routes

| Where it runs | Route | Purpose |
| --- | --- | --- |
| Local service (`npm start`) | `POST /execute` | Runs one signed release |
| Local service | `GET /health` | Shows the process is up |
| Vercel | `POST /api/execute` | The same handler, behind the `/api` prefix |
| Vercel | `GET /api/health` | Shows the function is up. It reads no settings and checks no database |

On Vercel the `/api` prefix is removed before the request is handled, so the same rules apply to both. Any other route or method returns `404` with `{"error":"not found"}` from the service.

`GET /health` (and `/api/health` on Vercel) returns `200` with `{"status":"UP"}`. It does not check the database or the business system.

## The release

parmana-core POSTs a JSON body with two keys, `release` and `signature`:

```json
{
  "release": {
    "version": 1,
    "connectorId": "...",
    "audience": "https://parmana-connectors.vercel.app/api/execute",
    "businessTransactionId": "txn-...",
    "authorizationId": "...",
    "capability": "razorpay:refund",
    "target": "pay_...",
    "parameters": { "amount": 100 },
    "policy": { },
    "approvedBy": [ ],
    "issuedAt": "2026-10-29T15:00:00.000Z",
    "expiresAt": "2026-10-29T15:05:00.000Z"
  },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "default",
    "value": "<base64 signature>"
  }
}
```

The service reads these fields:

| Field | Rule |
| --- | --- |
| `release.version` | Must be `1` |
| `release.businessTransactionId` | Non-empty string. Used as the replay key, and as the Razorpay receipt |
| `release.capability` | Non-empty string. Must be one the endpoint serves |
| `release.target` | Non-empty string. The connector checks its format |
| `release.audience` | Non-empty string. Must equal this endpoint's URL |
| `release.expiresAt` | A date string. The release is refused after it, plus 30 seconds |
| `release.parameters` | An object. The connector checks its contents |
| `signature.algorithm` | Must be `ed25519` |
| `signature.keyId` | Must be `default` |
| `signature.value` | Base64 signature over the canonical serialization of `release` (from `@parmana/crypto`) |

`connectorId` must be `ext-` followed by the release's `capability`, for example `ext-razorpay:refund`. This is the identity parmana-core signs for an external release. The other fields (`authorizationId`, `policy`, `approvedBy`, `issuedAt`, `conditions`) are not checked by this service. They are covered by the signature, so changing any of them after signing fails the signature check.

## Checks

Every check runs, and a refused release returns all the reasons it found. A release that carries business conditions (`release.conditions`, a non-empty list) is refused unless this service has an evaluator for every condition's `signalKey`. A refused release is not claimed, so it can be sent again. Covered conditions are checked after the claim and before the connector is called: a condition that does not hold is answered with `success: false` and `conditionsNotMet: true`, and the connector is not called; a condition whose evaluator fails is answered with `success: false` and no `conditionsNotMet`. Either answer is stored, so a repeat gets the same answer. Every answer that checked conditions lists them in `conditionsChecked`. Each entry gives its `outcome` (`holds`, `not-holding` or `unverified`), the evidence observed (when there is any), and how the check relates to the vendor action (`atomic` or `check-then-act`). A not-met or unverifiable answer includes the condition that failed. A refused release is not recorded, so it can be sent again with a fresh signature. A release that passes these checks is then recorded in the release ledger (see below).

1. **Shape.** The body is a JSON object with `release` and `signature` objects, and at most 256 KB. Otherwise `400` (or `413` for an over-size body).
2. **Signature.** Verified with Parmana's Ed25519 public key. Checks the algorithm and key id too. A release whose canonical bytes are longer than 4096 bytes is signed by parmana-core over a commitment: the prefix `PARMANA-ED25519-LARGE-MESSAGE-V1` and a NUL byte, followed by the SHA-512 of the canonical bytes. The service accepts that form only for such releases, so a commitment cannot stand in for a signature over a short message (gap G-131).
3. **Audience.** `release.audience` equals this endpoint's URL, exactly.
4. **Capability.** The endpoint serves `release.capability`.
5. **Expiry.** `now` is not later than `expiresAt` plus 30 seconds.
6. **Ledger.** The release's `businessTransactionId` is claimed in the release ledger before the connector runs. Exactly one claim succeeds. A second release with the same id is never run again: it receives the first answer (see [`200`: a repeat](#200-a-repeat-gets-the-first-answer)). A claim with no stored answer means the first run has not finished, or stopped before it stored its answer; a repeat then gets `409` (gap G-132).

The release ledger is `parmana_connectors_release_ledger`. Each row keeps the `businessTransactionId`, its `expires_at`, and the stored answer. The service never deletes a row. Once a release has an answer and its window has closed by at least 60 seconds, `npm run ledger:archive` moves the row to `parmana_connectors_release_ledger_archive` in one statement. The archive keeps the id blocked, so a claim for an archived id returns the stored answer and never runs the connector again. A row with no stored answer is never archived, because its outcome is unknown.

## Answers

### `200`: a repeat gets the first answer

A release whose `businessTransactionId` has already run receives the stored answer, byte for byte, with `200`. The connector does not run again. The log records `release_repeated`.

A repeat that arrives while the first run is still in progress, or after the first run stopped before storing its answer, gets `409` with `{"error":"this release is already being executed; retry later"}`. Nothing runs.

### `200`: the release ran

```json
{
  "businessTransactionId": "txn-...",
  "capability": "razorpay:refund",
  "success": true,
  "result": { "status": 200, "body": { } },
  "executedAt": "2026-10-29T15:00:01.000Z"
}
```

`result.body` is whatever the connector returns. For `razorpay:refund` see [the Razorpay README](../src/connectors/razorpay/README.md).

`executedAt` is the time the answer was built, after the connector returned.

### `200` with `success: false`: the connector failed

```json
{
  "businessTransactionId": "txn-...",
  "capability": "razorpay:refund",
  "success": false,
  "result": { "error": "connector failed: upstream_error" },
  "executedAt": "2026-10-29T15:00:01.000Z"
}
```

Only the error code leaves the service. For a failure that is not a connector error, the text is `connector failed`. The connector's own message is written to the log, not returned (see [Logs](#logs)). The release stays recorded, so it cannot be sent again. Check the business system before doing anything else. [RUNBOOK.md](../RUNBOOK.md) describes how.

If the connector's answer is larger than 16 KB, the service returns `200` with `success: false` and `result` set to `{"error":"result is larger than 16 KB"}`.

### `403`: a check refused the release

```json
{
  "error": "release refused",
  "errors": [
    "the signature does not verify",
    "release.audience \"...\" is not this endpoint"
  ]
}
```

Nothing ran. A refused release is not recorded, so it can be sent again with a fresh signature once the reason is fixed.

### `400`: not a release

```json
{ "error": "request body is not a signed release" }
```

Returned for a body that is not JSON, not an object, or missing `release` or `signature` objects.

### `413`: body too large

```json
{ "error": "request body is larger than the limit" }
```

The limit is 256 KB.

### `500`: the service could not check or run the release

- `{"error":"internal error"}` when the release ledger is unavailable. Nothing ran, so the same release may be sent again.
- `{"error":"service is not configured"}` on Vercel when a setting is missing or invalid. The reason is in the log as `service_not_configured`. Nothing ran.

## Limits

| Limit | Value | Where it applies |
| --- | --- | --- |
| Request body | 256 KB | Local service and Vercel |
| Result | 16 KB, as JSON | Local service and Vercel |
| Clock skew allowed on expiry | 30 seconds | Local service and Vercel |
| Request headers | 10 seconds | Local service only (`server.headersTimeout`) |
| Whole request | 30 seconds | Local service only (`server.requestTimeout`) |
| Connector call | `PARMANA_CONNECTOR_TIMEOUT_MS`, default 10 s | The generic connector applies it to each upstream call. The Razorpay connector applies it to all of its calls for one release together, see [the Razorpay README](../src/connectors/razorpay/README.md) |
| Shutdown | 25 seconds for in-flight requests | Local service only |

## Logs

The service writes one JSON line per event to stdout. Each line has `time` and `event`, plus the fields below. No line contains a credential or a request body. The one line that carries connector text is `connector_failed`, whose `detail` is the connector's own message, capped at 300 characters. Connectors are written so that the message never holds a credential or a response body.

| Event | Fields | When |
| --- | --- | --- |
| `service_started` | `connector`, `host`, `port`, `releaseLedger` | Local service started listening |
| `release_ledger_memory` | `warning` | `PARMANA_RELEASE_LEDGER=memory` is in use |
| `release_ledger_setting_deprecated` | `deprecated`, `use` | The old `PARMANA_NONCE_STORE` name is set; use `PARMANA_RELEASE_LEDGER` instead |
| `release_repeated` | `businessTransactionId`, `capability` | A release was sent again. The stored answer, or `409`, was returned. Nothing ran |
| `release_answer_not_stored` | `businessTransactionId` | The connector ran, but its answer could not be stored. A repeat gets `409` |
| `release_refused` | `reasons` (a count) | A check refused the release |
| `release_answered` | `businessTransactionId`, `capability`, `success` | The connector ran (or failed) and the answer was sent |
| `connector_failed` | `businessTransactionId`, `capability`, `code`, `detail` | The connector threw. `code` is its error code, or `unknown`. `detail` is its message, or `none` |
| `release_check_unavailable` | none | The release ledger failed. The release was not run |
| `unhandled_error` | none | An unexpected error in the local service. It returns `500` |
| `service_not_configured` | `reason` (names the setting, never its value) | Vercel: a setting is missing or invalid |
| `shutdown_started` | `signal` | SIGTERM or SIGINT received |
| `shutdown_forced` | none | In-flight requests did not finish within 25 seconds, and the process exited |
| `shutdown_complete` | none | Clean exit after shutdown |

For Razorpay, the `detail` carries Razorpay's error code and description, for example `Razorpay refused creating the refund (HTTP 400, code BAD_REQUEST_ERROR: ...)`. A failed refund call that may have created a refund says so, and names the receipt to check in Razorpay.
