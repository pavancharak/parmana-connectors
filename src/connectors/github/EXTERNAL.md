# GitHub external endpoint

This is the GitHub connector run as an external endpoint (ADR-0013). Parmana releases each approved request to the endpoint as a signed body, `{ release, signature }`. The endpoint verifies it with `verifyParmanaRelease` from `@parmana/sdk`, then acts with its own credentials.

## GitHub endpoint

`external-endpoint.ts` serves **all three GitHub capabilities**: `github:pr-fetch`, `github:pr-merge` and `github:comment`. Any other capability is refused with 403 before GitHub is called. Parmana releases a write only after its approvals, and the release carries them, so the endpoint does not check approvals again.

| Status | When |
| --- | --- |
| 200 | The release is verified and acted on, or it was answered before (the first answer is returned). |
| 401 | The body is not `{ release, signature }`, the signature does not verify, the audience differs from `ENDPOINT_URL`, or the release has expired. GitHub is not called. |
| 403 | A valid release for a capability this endpoint does not serve, such as `github:pr-delete`. GitHub is not called. |
| 405 | Not a POST. |
| 500 | The handler failed unexpectedly. |

A GitHub failure is still answered with status 200 and `success: false`, with the connector's error code. That answer is stored as the first answer, so a replay cannot act again.

### Environment (`src/external/github-release-server.ts`)

| Variable | Value |
| --- | --- |
| `PARMANA_PUBLIC_KEY_PEM` | Parmana's public key, PEM, from `client.publicKey("default")` |
| `ENDPOINT_URL` | This endpoint's URL exactly as registered in Parmana |
| `GITHUB_APP_CREDENTIAL` | `<app id>:<installation id>:<base64 of the App's PEM key>` |
| `PORT` | Optional, default 8080 |

Run it with `npx tsx src/external/github-release-server.ts`. Serve it over HTTPS behind a TLS-terminating proxy. Parmana releases only to https.

### What is tested

`tests/connectors/github/github-external-endpoint.test.ts` (9 tests): a valid release, the credential never returned, bad signature, wrong audience, expired release, a refused capability, a body that is not a release, replay of a success, and replay of a failure. All run against a fake GitHub.

The HTTP server was also run locally. A GET returned 405, a bad signature returned 401, and a valid merge release returned 403. Those requests made no GitHub call.

## Not done yet

- **A durable answer store.** The first answers are in memory, so a restart forgets them and a replay after a restart could act again. Production needs a database table keyed by `businessTransactionId`, passed in as `answers`.
- **Deployment.** The endpoint is not deployed. It needs a public HTTPS host, which means a new Vercel project or another host.
- **Registration.** Parmana has to be told about the endpoint through a registration change, which a checker approves. That approval needs the checker's own key on the checker's machine.
- **Policies.** `github:pr-fetch` is not bound to a policy in production yet. Parmana won't release to the endpoint until it is.
- **Policies for the writes.** `github:pr-merge` maps to `github-pr-approval` 1.1.0, and `github:comment` has no policy yet. Parmana won't release a write until its policy is bound.
