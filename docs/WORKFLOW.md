# Workflow: branches, sign-off, signing and pull requests

These are the steps for changing this repository and getting a change onto `main`. For what each connector does and how to run it, see the connector folders under [src/connectors](../src/connectors). For sign-off rules, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. Work on a branch

Start from the latest `main`, on a new branch:

```bash
git fetch origin
git checkout -B <your-branch> origin/main
```

Do not commit to `main` directly.

## 2. Sign off each commit (DCO)

Every commit in a pull request needs a `Signed-off-by` line. The DCO check fails without it:

```bash
git commit -s -m "<what changed and why>"
```

To add it to a commit that lacks it: `git commit -s --amend` for the last commit, or `git rebase --signoff <base>` for several.

## 3. Sign the commits (required on `main`)

`main` requires signed commits. Each commit must be signed with your key, not only signed off. Check a branch's commits:

```bash
git log --format='%h %G? %s' origin/main..HEAD
```

Each line should show `G` (good) or `U` (signed, key not trusted on this machine). `N` means unsigned. To sign every commit on a branch:

```bash
git rebase --force-rebase --gpg-sign origin/main
```

## 4. Push

Push the branch:

```bash
git push -u origin <your-branch>
```

If you have already pushed this branch and rewritten its commits, use a lease, so the push only succeeds if the remote is still where you last saw it:

```bash
git push --force-with-lease=<your-branch>:<remote commit> -u origin <your-branch>
```

Use a force-push only on a branch that is not merged, and only when you know nobody else has pushed to it.

## 5. Open the pull request

Open a pull request into `main`. Fill in the repository's pull request template, and tick only the checks that are true. Do not merge a pull request that fails a required check.

## 6. Connector changes

A change to a connector needs its tests to pass locally before the pull request is opened:

```bash
npm ci
npm run typecheck
npm test
```

A change that affects how a connector is deployed or run must also follow that connector's runbook. The GitHub connector's runbook is in [src/connectors/github/RUNBOOK.md](../src/connectors/github/RUNBOOK.md), and the Razorpay deployment runbook is in [RUNBOOK.md](../RUNBOOK.md).
