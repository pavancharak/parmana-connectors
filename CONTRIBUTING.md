# Contributing to parmana-connectors

Thank you for looking. This repository runs the code that performs actions in business systems for Parmana. Changes are reviewed with that in mind. Read the [README](README.md) for what the service does and the rules for connectors before you change anything.

## Before you start

- Branch from `main`. Do not commit to `main` directly.
- Check which repository you are in before a Git command: `git remote get-url origin`.
- Never commit a credential, a `.env` file, a key pair or a `*.pem` file. `.gitignore` covers them, but check `git status --short` before each commit.

## Sign-off (DCO)

Every commit in a pull request needs a `Signed-off-by` line. The DCO check fails without it. Sign each commit with `-s`:

```bash
git -c user.name="<Your Name>" -c user.email="<your email>" commit -s -m "<type>: <what changed and why>"
```

The check only tests that the line is there. Policy also requires the sign-off name and email to be the commit's author, and the person who submits the change to be both. If a commit lacks the line, add it with `git commit -s --amend` (for the last commit) or rebase with `--signoff`. Do not use `--no-verify` to skip hooks.

## Checks to run before you push

Use Node 24, the version CI uses:

```bash
npm ci
npm run build
npm run typecheck
npm test
```

The three PostgreSQL tests in `tests/service/nonce-store.postgres.test.ts` are skipped unless `PARMANA_TEST_DATABASE_URL` points at a PostgreSQL database. CI sets it. To run them locally, start a PostgreSQL database and set the variable to its URL. The test creates and drops its own table.

The boundary test (`tests/boundaries.test.ts`) must pass. It enforces the import rules for connectors.

## What CI runs

| Workflow | Runs on | What it checks |
| --- | --- | --- |
| CI (`ci.yml`) | Pushes to `main`, pull requests | `npm ci`, `npm run build`, `npm test` on Node 24, with PostgreSQL 16 running |
| CodeQL (`codeql.yml`) | Pushes to `main`, pull requests into `main`, weekly | JavaScript and TypeScript static analysis |
| DCO (`dco.yml`) | Pull requests into `main` | A `Signed-off-by` line on every non-merge commit. Dependabot's pull requests are exempt |
| Dependency review (`dependency-review.yml`) | Pull requests into `main` | Newly added dependencies with known vulnerabilities |

Dependabot opens grouped pull requests each week for minor and patch updates. Major updates of `typescript`, `vitest`, `@vitest/*` and `@types/node` are ignored, because they may need code changes. Open them by hand when the work is planned.

Do not push an empty commit to re-run a check. Fix the cause, or re-run the failed job.

## Ownership and review

Code owners are listed in `.github/CODEOWNERS`. Changes to the service (`src/service/`), to the connectors (`src/connectors/`), to `.github/`, and to `package.json` or `package-lock.json` need the owner's review. Describe each change in its pull request: what changed, why, the checks you ran, and anything you did not verify.

This repository has no pull request template.

## Adding a connector

Follow [README: Adding a connector](README.md#adding-a-connector). A new connector is a security change. It moves money or changes data in a business system, so it needs the owner's review and tests against a fake of the vendor's API. Document it in `src/connectors/<vendor>/README.md`, as [the Razorpay README](src/connectors/razorpay/README.md) does.

## Deployment

Pushes to `main` deploy to Vercel production. Other branches get preview deployments. Read [RUNBOOK.md](src/connectors/razorpay/RUNBOOK.md) before changing anything that affects production, and never change a production setting in a way the runbook does not describe.

## Reporting a security problem

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
