# GitHub external endpoint

This is the GitHub connector run as an external endpoint (ADR-0013). Parmana releases each approved request to the endpoint as a signed body, `{ release, signature }`. The endpoint verifies it with `verifyParmanaRelease` from `@parmana/sdk`, then acts with its own credentials.

## GitHub endpoint

`external-endpoint.ts` serves **only `github:pr-merge`**. Reads (`github:pr-fetch`), comments (`github:comment`) and any other capability are refused with 403 before GitHub is called. The endpoint is kept to the one action that needs a human approval; see commit `0a44161`. Parmana releases a write only after its approvals, and the release carries them, so the endpoint does not check approvals again.

| Status | When |
| --- | --- |
| 200 | The release is verified and acted on, or it was answered before (the first answer is returned). |
| 401 | The body is not `{ release, signature }`, the signature does not verify, the audience differs from `PARMANA_RELEASE_AUDIENCE`, or the release has expired. GitHub is not called. |
| 403 | A valid release for a capability this endpoint does not serve, such as `github:pr-delete`. GitHub is not called. |
| 405 | Not a POST. |
| 500 | The handler failed unexpectedly. |

A GitHub failure is still answered with status 200 and `success: false`, with the connector's error code. That answer is stored as the first answer, so a replay cannot act again.

### Environment (`src/external/github-release-server.ts`)

The names match the connectors' Razorpay service. The full rules are in `github-endpoint-config.ts`.

| Variable | Value |
| --- | --- |
| `PARMANA_PUBLIC_KEY` | Parmana's Ed25519 public key as PEM text. Set this or `PARMANA_PUBLIC_KEY_FILE`, never both. |
| `PARMANA_PUBLIC_KEY_FILE` | A path to the same PEM. |
| `PARMANA_RELEASE_AUDIENCE` | This endpoint's `https://` URL, exactly as registered in Parmana |
| `GITHUB_APP_CREDENTIAL` | `<app id>:<installation id>:<base64 of the App's PEM key>` |
| `PORT` | Optional, default 8080 |

Run it with `npm run start:github-endpoint`. Serve it over HTTPS behind a TLS-terminating proxy. Parmana releases only to https.

### What is tested

`tests/connectors/github/github-external-endpoint.test.ts` (9 tests): a valid release, the credential never returned, bad signature, wrong audience, expired release, a refused capability, a body that is not a release, replay of a success, and replay of a failure. All run against a fake GitHub.

The HTTP server was also run locally. A GET returned 405, a bad signature returned 401, and a valid merge release returned 403. Those requests made no GitHub call.

## Not done yet

- **A durable answer store.** The first answers are in memory, so a restart forgets them and a replay after a restart could act again. Production needs a database table keyed by `businessTransactionId`, passed in as `answers`.
- **Deployment.** The endpoint is not deployed. It needs a public HTTPS host, which means a new Vercel project or another host.
- **Registration.** Parmana has to be told about the endpoint through a registration change, which a checker approves. That approval needs the checker's own key on the checker's machine.
- **Policy.** `github:pr-merge` maps to `github-pr-approval` 1.1.0. Parmana won't release a merge until that policy is bound. The endpoint does not serve `github:pr-fetch` or `github:comment`, so their policies do not affect it.
