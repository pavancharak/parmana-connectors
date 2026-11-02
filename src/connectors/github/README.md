# GitHub connector

Two capabilities on a pull request, `owner/repo#number`. It is the GitHub connector moved from parmana-core under ADR-0018.

- **`github:pr-fetch`** reads the pull request's mergeable state, its merge time, its head SHA and its base branch.
- **`github:pr-merge`** merges it. `mergeMethod` must be `merge`, `squash` or `rebase`. `expectedHeadSha`, if given, must be a 40 character lowercase SHA. GitHub refuses the merge if the head has moved since the decision was made.

- **Code:** `github-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Credential:** `GITHUB_APP_CREDENTIAL`, `<app id>:<installation id>:<base64 of the App's PEM private key>`. For each call the connector signs a short-lived JWT, exchanges it for an installation token, and uses that token once. The token is never stored. Errors and results show only a fingerprint of it.
- **Parameters:** only the ones listed above are allowed for each capability. Any other is refused before a call.
- **Repeats:** a repeated merge of a merged pull request fails at GitHub rather than merging twice. It is not checked before sending, so the error says to check the pull request.
- **Checks:** tests use a fake GitHub and a generated RSA key, in `tests/connectors/github/`. The request shapes are the in-core connector's and have not been checked against a live GitHub App.

If a merge request may have reached GitHub and no answer was read, the error says to check the pull request before any other action.
