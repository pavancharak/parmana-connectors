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

The other fields (`connectorId`, `authorizationId`, `policy`, `approvedBy`, `issuedAt`, `conditions`) are not checked by this service. They are covered by the signature, so changing any of them after signing fails the signature check.

## Checks

Every check runs, and a refused release returns all the reasons it found. The replay check runs only when the other checks pass.

1. **Shape.** The body is a JSON object with `release` and `signature` objects, and at most 256 KB. Otherwise `400` (or `413` for an over-size body).
2. **Signature.** Verified with Parmana's Ed25519 public key. Checks the algorithm and key id too.
3. **Audience.** `release.audience` equals this endpoint's URL, exactly.
4. **Capability.** The endpoint serves `release.capability`.
5. **Expiry.** `now` is not later than `expiresAt` plus 30 seconds.
6. **Replay.** The key `release:<businessTransactionId>` is recorded in the replay table before the connector runs. A second release with the same id is refused, even if the first one failed at the business system.

The replay table is `parmana_connectors_nonces`. Each row keeps its key and `expires_at`. There is no timer. When the service checks a release, it first deletes rows that expired more than 5 minutes earlier. Once a row is gone, the same key would pass the replay check again.

## Answers

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

`result.body` is whatever the connector returns. For `razorpay:refund` see [RAZORPAY.md](RAZORPAY.md).

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

Only the error code leaves the service. For a failure that is not a connector error, the text is `connector failed`. The detail is not logged either (see [Logs](#logs)). The release stays recorded, so it cannot be sent again. Check the business system before doing anything else. [RUNBOOK.md](../RUNBOOK.md) describes how.

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

Nothing ran. A release refused for any reason except the replay check can be sent again with a fresh signature. The replay refusal reads `this businessTransactionId was already executed`.

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

- `{"error":"internal error"}` when the replay store is unavailable. Nothing ran, so the same release may be sent again.
- `{"error":"service is not configured"}` on Vercel when a setting is missing or invalid. The reason is in the log as `service_not_configured`. Nothing ran.

## Limits

| Limit | Value | Where it applies |
| --- | --- | --- |
| Request body | 256 KB | Local service and Vercel |
| Result | 16 KB, as JSON | Local service and Vercel |
| Clock skew allowed on expiry | 30 seconds | Local service and Vercel |
| Request headers | 10 seconds | Local service only (`server.headersTimeout`) |
| Whole request | 30 seconds | Local service only (`server.requestTimeout`) |
| Connector call | `PARMANA_CONNECTOR_TIMEOUT_MS`, default 10 s | Generic connector. The Razorpay connector uses its own fixed limit, see [RAZORPAY.md](RAZORPAY.md) |
| Shutdown | 25 seconds for in-flight requests | Local service only |

## Logs

The service writes one JSON line per event to stdout. Each line has `time` and `event`, plus the fields below. No line contains a credential, a request body, or an upstream response.

| Event | Fields | When |
| --- | --- | --- |
| `service_started` | `connector`, `host`, `port`, `nonceStore` | Local service started listening |
| `nonce_store_memory` | `warning` | `PARMANA_NONCE_STORE=memory` is in use |
| `release_refused` | `reasons` (a count) | A check refused the release |
| `release_answered` | `businessTransactionId`, `capability`, `success` | The connector ran (or failed) and the answer was sent |
| `connector_failed` | `businessTransactionId`, `capability`, `code` | The connector threw. `code` is its error code, or `unknown` |
| `release_check_unavailable` | none | The replay store failed. The release was not run |
| `unhandled_error` | none | An unexpected error in the local service. It returns `500` |
| `service_not_configured` | `reason` (names the setting, never its value) | Vercel: a setting is missing or invalid |
| `shutdown_started` | `signal` | SIGTERM or SIGINT received |
| `shutdown_forced` | none | In-flight requests did not finish within 25 seconds, and the process exited |
| `shutdown_complete` | none | Clean exit after shutdown |

The Razorpay error description is not logged. The log has the error code only (for example `upstream_error`). Use Razorpay's own dashboard to see why a refund was refused.
