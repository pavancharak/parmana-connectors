# GitHub comments: how `github:comment` works

This file covers the `github:comment` capability only. For running the connector, see [RUNBOOK.md](RUNBOOK.md). For the connector as a whole, see [README.md](README.md).

## What one request does

A request posts **one** comment on one pull request, through the GitHub App's installation token.

| Field | Required | Rule |
| --- | --- | --- |
| `capability` | yes | `github:comment` |
| `target` | yes | `<owner>/<repo>#<pull number>`, for example `acme/payments#17` |
| `parameters.body` | yes | A non-empty string of at most 4,000 characters. It is the only parameter allowed |
| `businessTransactionId` | yes | Letters, digits, dots, colons, underscores or hyphens. At most 128 characters |

A request that breaks a rule is refused before any call to GitHub. Its error names the rule, and never shows the credential.

## What authorizes a comment

The `github-pr-comment` policy needs **two** signed approvals from trusted people:

- a **target approval** for the exact pull request (`owner/repo#number`), and
- a **body approval** for the exact comment text.

Each approval is checked on its own. A comment is refused if either one is missing, is for another pull request, or is for different text. Changing one word of the text needs a new body approval.

## What is posted

The text GitHub receives is your `body`, then a blank line, then a hidden marker:

```
<your body>

<!-- parmana:btx=<businessTransactionId> -->
```

GitHub renders the comment as Markdown. The marker is an HTML comment, so readers do not see it. It is there for search, described below.

Your body is posted as written. It is not checked for content beyond its length.

## What the connector returns

On success it returns the new comment's `commentId` and its `url`, plus a short fingerprint of the installation token. The token itself is never returned or logged.

## Finding the comment for a release

Use this when an answer was lost, or when you need to show which comment a release produced.

Search the pull request's comments for the marker text, `parmana:btx=<businessTransactionId>`. With the GitHub CLI, from a machine that is signed in:

```bash
gh api repos/<owner>/<repo>/issues/<pull number>/comments --paginate --jq '.[] | select(.body | contains("parmana:btx=<businessTransactionId>")) | {id, html_url}'
```

- **One result:** the comment was posted for that release. Record its `html_url`. Do not post again.
- **No result:** no comment carries that marker, so none was posted for that release, as far as GitHub shows.
- **More than one result:** stop, and tell the owner. A release should post at most one comment.

Comments posted before the marker was added have no marker. A search cannot find them. Check those by reading the pull request by hand.

## Repeats

- **The same release sent again** is refused by the release ledger in the service, so it posts nothing. See [RUNBOOK.md](RUNBOOK.md) for the recovery steps.
- **A new approval for the same text** is a new release, with a new transaction ID. It posts a second comment. That is intended, and it is the open decision recorded in [RUNBOOK.md](RUNBOOK.md) under Known gaps.

## Errors

The table of errors and their fixes is in [RUNBOOK.md](RUNBOOK.md#errors-you-may-see). The two specific to comments are:

- `upstream_error`, "The comment may have reached GitHub": the post may have been made, and no answer was read. Search for the marker before doing anything else.
- `upstream_error`, "GitHub did not post the comment (HTTP 403)" or `(HTTP 404)`: the App lacks write access, is not installed on the repository, or the pull request number is wrong.

## Not covered

- Editing or deleting a comment. The connector only creates comments.
- Comments on issues that are not pull requests. The target form is the same, but this has not been tested.
- Mentions and notifications. A body that mentions a user will notify them, and nothing checks for that.
