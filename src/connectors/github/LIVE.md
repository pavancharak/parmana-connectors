# Live GitHub connector tests

These tests call GitHub's real API with a real GitHub App. They check what the unit tests can't: that GitHub accepts the App's signed JWT, issues an installation token, grants the permissions the connector uses, and returns the fields the connector reads.

Read `CAPABILITIES.md` in `src/connectors/github/` first, for what each capability does and what each test covers.

## What runs, and when

Nothing here runs by default. A plain `npm test` skips every live test.

| Switch | What it enables |
| --- | --- |
| `ALLOW_LIVE_GITHUB=1` | Every live test. Without it, the file is skipped. With it set but a variable missing, the run fails rather than skipping. |
| `ALLOW_LIVE_GITHUB_WRITES=1` | The comment test and the merge tests. Needs a disposable pull request for each. |

| Test | Needs writes | What it does |
| --- | --- | --- |
| `github:pr-fetch` returns the head SHA, mergeable state and base branch | No | Reads `TEST_GITHUB_TARGET` |
| `github:pr-fetch` refuses a pull request number that does not exist | No | Reads a number that should be missing (404) |
| `github:comment` posts with the transaction marker | Yes | Posts one comment on `TEST_GITHUB_WRITE_TARGET` |
| `github:pr-merge` with the current head SHA merges | Yes | Merges `TEST_GITHUB_MERGE_TARGET`. Irreversible. |
| `github:pr-merge` refuses a stale head SHA | Yes | Sends an all-zero SHA to `TEST_GITHUB_STALE_TARGET`. GitHub must refuse, and the PR must stay open. |

## Environment variables

Set these in `.env.live`, in the repository root. The file is git-ignored (see `.gitignore`: `.env` and `.env.*`). `.env.example` lists the names with blank values.

| Variable | Value |
| --- | --- |
| `ALLOW_LIVE_GITHUB` | `1` to run the live tests |
| `ALLOW_LIVE_GITHUB_WRITES` | `1` to run the write tests. Leave `0` for read-only runs. |
| `TEST_GITHUB_APP_ID` | The GitHub App's numeric App ID, shown on the App's settings page |
| `TEST_GITHUB_INSTALLATION_ID` | The installation ID, the number at the end of the installation page URL |
| `TEST_GITHUB_APP_PRIVATE_KEY` | Path to the App's `.pem` private key, or the PEM text itself |
| `TEST_GITHUB_TARGET` | `owner/repo#NUMBER` of an open pull request, for reads |
| `TEST_GITHUB_WRITE_TARGET` | A disposable pull request for the comment test |
| `TEST_GITHUB_MERGE_TARGET` | A disposable pull request for the merge test. It is merged. |
| `TEST_GITHUB_STALE_TARGET` | A second disposable pull request, still open, for the stale-SHA test |

Two things that trip people up:

- **Quote any value with `#` in it.** Node's env-file parser reads an unquoted `#` as the start of a comment, so `owner/repo#7` loads as `owner/repo`. The test then fails with "The live target must be". Write `TEST_GITHUB_TARGET="owner/repo#7"`.
- **Keep the key out of the repository.** Store the `.pem` somewhere outside any repo, and never paste its contents into a file, a command, or a chat. The `*.pem` pattern is git-ignored, but that only protects against an accidental `git add`.

## Setting up the GitHub App

Do this once, on the account that owns the test repository.

1. Create the test repository and an open pull request in it.
2. Go to Settings, then Developer settings, then GitHub Apps, then **New GitHub App**.
3. Give the App a name. The Homepage URL is required. Use the repository URL.
4. Leave Redirect URI empty. The connector doesn't use user sign-in.
5. Untick **Webhook: Active**. The connector doesn't need webhooks.
6. Set permissions:
   - **Pull requests:** Read and write.
   - **Contents:** Read and write. A merge needs this.
   - **Metadata:** Read. GitHub sets this one.
7. Set **Where can this GitHub App be installed** to **Only on this account**.
8. Create the App, then note its **App ID**.
9. Click **Generate a private key**. GitHub downloads a `.pem` file. Move it out of Downloads, to a folder you control.
10. Install the App, and choose **Only select repositories**, then pick the test repository. The **installation ID** is the number at the end of the URL, such as `/settings/installations/12345678`.

Permission names and menu labels can change. If a screen differs from these steps, check GitHub's documentation for GitHub Apps.

## Running the tests

From the repository root:

```bash
npm run test:live:github
```

The script loads `.env.live` with `node --env-file-if-exists`, then runs `tests/connectors/github/github-live.test.ts`.

To check what Node loads for one variable:

```bash
node --env-file-if-exists=.env.live -e "console.log(JSON.stringify(process.env.TEST_GITHUB_TARGET))"
```

On Windows PowerShell, the same command is:

```powershell
node --env-file-if-exists=.env.live -e "console.log(JSON.stringify(process.env.TEST_GITHUB_TARGET))"
```

Run the read tests first, with `ALLOW_LIVE_GITHUB_WRITES=0`. Only switch writes on after the reads pass, and only with disposable pull requests in place.

## Disposable pull requests

Every write test needs its own disposable pull request. Rules:

- **Never** use a real pull request, or one anyone else is working on.
- **Never** reuse a merged pull request. A merge test merges its target, so the next run needs a new one.
- The **stale-SHA** test needs a pull request that stays **open**. Its target is never merged.
- The **comment** test adds a comment every run. Comments can't be removed by the connector.

Before a write run, open each disposable pull request from its own throwaway branch, with a one-line change.

## Timeouts

`tests/connectors/github/github-live.test.ts` sets a 60 second limit for each test. vitest's default of 5 seconds is too short for real GitHub calls. A merge can complete on GitHub and still be reported as a timeout if the limit is too short.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Missing script: "test:live:github"` | Your checkout is on a branch without the script. Switch to `claude/gifted-cori-6l7cux`, or the branch you have. |
| "The live target must be `<owner>/<repo>#<number>`" | `#` in an unquoted value. See Environment variables. |
| "ALLOW_LIVE_GITHUB=1 is set but TEST_GITHUB_... is not" | A variable is missing from `.env.live`, or the file isn't in the directory you ran from. |
| `credential_invalid`, "GitHub refused the App token request (HTTP 401)" | The App ID, installation ID or key doesn't match. Check that the key belongs to this App. |
| `credential_invalid`, HTTP 403 | The App is installed on a different repository, or lacks the permission. |
| `upstream_error`, "HTTP 404" on the read | The pull request number doesn't exist in that repository. |
| `upstream_error`, "HTTP 405" on merge | The pull request is already merged, or GitHub reports it as not mergeable. Use a new disposable pull request. |
| `upstream_error`, "HTTP 409" on merge | The head moved since the SHA was read. This is what the stale-SHA test expects. |
| "Cannot update this protected ref" | Branch protection or a ruleset on the base branch. See the test repository's README. |

## Recording results

Record each run in the test repository, in a dated file under `docs/`, as the test repository's `docs/LIVE-CONNECTOR-RUN-2026-11-24.md` does. Say which staging-plan cases the run covers, and which it doesn't. These tests call the connector directly, so they don't cover policies, approvals, the nonce store or Parmana's release path.
