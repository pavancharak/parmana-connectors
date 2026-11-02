# parmana-connectors runbook: steps, process and commands

This runbook takes you from an empty Vercel project to a verified production deployment of the connector service, then covers how to ship changes safely. Each step gives the command, the expected result, and what to do if the result differs.

## Before you start

**Accounts you need**

- GitHub access to `pavancharak/parmana-connectors` and `pavancharak/parmana-core`.
- A Vercel account in team `pavan-dev-singh-charaks-projects`.
- A Supabase account, with a free project slot available.
- A Razorpay account in test mode, with a test API key pair.

**Tools on your Windows machine**

- Git.
- Node.js 24. CI uses 24. The sandbox used 22, which also passed the tests.
- The Vercel CLI, installed globally: `npm install -g vercel`.
- Sign in once with `vercel login`. Then link the folder with `vercel link`, choosing the `parmana-connectors` project.

**Rules that apply to every step**

- Never paste a secret into chat, a file, a commit or a log. Secrets go only into Vercel, your password manager, or your local `.env`, which Git ignores.
- Check which repository you are in before any Git command: `git remote get-url origin`.
- Create a new branch from `origin/main` before you edit. Do not commit to `main` directly.
- Read the output of every command. If it differs from the expected result, stop and go to Troubleshooting.

## Step 1: repository and branch rules

Work on `parmana-connectors` and `parmana-core` separately. They have different histories.

```bash
# Confirm which repository you are in
git remote get-url origin

# Get the latest main
git fetch origin main

# Start a branch from origin/main with a clear name
git checkout -B feat/<short-name> origin/main

# Confirm a clean tree
git status -sb
```

Expected: the `origin` URL matches the repository you intend, `git status -sb` shows only your branch name, and no changed files.

**Commit with your identity and a sign-off.** The repository's DCO check needs the commit author to match the `Signed-off-by` line. Pass the identity for that one commit, so the repository config stays unchanged:

```bash
git add <files you changed, by name>
git -c user.name="<Your Name>" -c user.email="<your email>" commit -s -m "<type>: <what changed and why>"
```

Add only the files you meant to change. Check `git status --short` before each commit.

**Push the branch:**

```bash
git push -u origin feat/<short-name>
git ls-remote --heads origin feat/<short-name>
```

Expected: the remote hash matches `git rev-parse --short HEAD`.

## Step 2: create and connect the Vercel project

1. Run `vercel link` in the `parmana-connectors` folder. Choose **Create a new project**, name it `parmana-connectors`, and connect the GitHub repository `pavancharak/parmana-connectors`.
2. When asked about settings, choose **Customize settings: no** if the framework is detected as Other, then correct the settings in the dashboard:
   - **Build command:** turn on the override and enter `echo "no static build"`. The TypeScript build is not run on Vercel.
   - **Output directory:** turn on the override and enter `public`.
   - **Install command:** `npm ci`.
   - **Node.js version:** 24.x.
3. In **Settings → Environments**, confirm **Production** tracks `main`, and **Preview** covers all other branches.

```bash
# Link the folder to the Vercel project (run once)
vercel link

# Check the link
vercel project ls
```

Expected: the project appears under team `pavan-dev-singh-charaks-projects`, and the Git connection shows `pavancharak/parmana-connectors`.

The `public/` folder must exist on the branch being deployed. It holds a placeholder page. Without it, the build fails with `STATIC_BUILD_NO_OUT_DIR`.

## Step 3: create the Supabase project and get its connection string

The connector's replay protection needs its own Postgres database. It must not be production core's database.

1. Check the project list. The free plan allows two active projects. One is production core's database, named `parmana-sandbox`. **Never pause or delete it.** If a slot is needed, free one by agreement with the owner, not by guessing.
2. Click **New project**. Name it `parmana-connectors`. Choose the region **South Asia (Mumbai), ap-south-1**. The region cannot be changed later.
3. Save the database password in your password manager. You will need it once more, in Step 5.
4. Wait until the project shows as ready.
5. Open **Connect**. Copy the **Transaction pooler** string (port 6543), with the password filled in.

The string has this form, with placeholders in capitals:

```
postgresql://<USER>:<PASSWORD>@<POOLER_HOST>:6543/postgres
```

Do not paste the string into chat or a file. You add it to Vercel in Step 5, using the prompt.

The service creates its own table at first start, so nothing else is needed in Supabase.

## Step 4: get Parmana's public key

The service checks each release against Parmana's Ed25519 public key. The key is public, so you can copy it. It is served by the production core API.

```bash
# Fetch the current key (read-only, public data)
curl -s https://parmana-api-real.vercel.app/keys/default
```

Expected: a JSON object with `"keyId":"default"`, `"algorithm":"ed25519"`, and a `pem` field.

To write the key as one line, with `\n` where the line breaks are, use the `pem` value. Example of the shape, not a real key:

```
-----BEGIN PUBLIC KEY-----\n<base64 key>\n-----END PUBLIC KEY-----
```

The service reads `\n` as a line break. Do not use a file path for this key on Vercel. A file in the repository would need a bundling setting, and that path has not been tested.

If the key has changed since it was copied, Parmana has rotated it. Update `PARMANA_PUBLIC_KEY` in Step 5, or releases will be refused.

## Step 5: set the Vercel environment variables

Each command prompts for the value, so the value never sits in your command history. Run them in this order. Choose the type shown in the table when the CLI asks.

```bash
vercel env add PARMANA_CONNECTOR production          # type: razorpay
vercel env add PARMANA_ALLOW_LIVE_KEYS production     # type: false
vercel env add PARMANA_NONCE_STORE production         # type: postgres
vercel env add PARMANA_PUBLIC_KEY production          # type: the one-line PEM from Step 4
vercel env add PARMANA_RELEASE_AUDIENCE production    # type: https://parmana-connectors.vercel.app/api/execute
vercel env add PARMANA_DATABASE_URL production        # paste the Supabase string from Step 3
vercel env add RAZORPAY_KEY_PAIR production          # type: your rzp_test_ key id, a colon, then the key secret
```

| Name | Type to choose | Why |
| --- | --- | --- |
| `PARMANA_PUBLIC_KEY` | Config | The key is public. Config lets you reveal the value later to check it |
| all others | Secret | Hidden in the dashboard and unavailable to pulls |

Leave these unset: `PARMANA_PUBLIC_KEY_FILE` (never set it with `PARMANA_PUBLIC_KEY`), `PARMANA_CONNECTOR_TIMEOUT_MS`, `PARMANA_SERVICE_PORT`, `PARMANA_SERVICE_HOST`.

**Check the names, not the values:**

```bash
vercel env ls production
```

Expected: the seven names above, each listed for `Production`.

**Changing a value.** Secret values cannot be read back. To change one, remove it and add it again:

```bash
vercel env rm <NAME> production
vercel env add <NAME> production
```

Environment changes apply only to new deployments. Redeploy after every change (Step 6).

**Do not add `RAZORPAY_KEY_PAIR` with a live key** until live use is approved. Use a `rzp_test_` key only.

## Step 6: deploy and verify

**Deploy.** Production deploys from `main`. Merging a pull request into `main` starts it. To redeploy the current `main` after a settings change, open the project in the Vercel dashboard, go to **Deployments**, open the latest production deployment, choose **… → Redeploy**, and wait for **Ready**.

**Watch the build log:**

```bash
vercel inspect parmana-connectors.vercel.app --logs
```

Expected: `no static build`, then `Build Completed`, then `Deployment completed`, then status `Ready`. A `TS2688` line may appear. It is a known warning, and the deployment still succeeds.

**Check the health route.** The production alias `https://parmana-connectors.vercel.app` answers without a login, so a plain request works:

```bash
curl -sS https://parmana-connectors.vercel.app/api/health
```

Expected: `{"status":"UP"}` with HTTP 200.

Deployment-specific addresses (the ones that contain a hash, such as `parmana-connectors-<hash>-pavan-dev-singh-charaks-projects.vercel.app`) are protected by Vercel Authentication. Use `vercel curl` for those, with the same path.

**Check the execute route with an unsigned request:**

```bash
curl -sS -X POST -H "Content-Type: application/json" -d "{}" https://parmana-connectors.vercel.app/api/execute
```

Expected: `{"error":"request body is not a signed release"}`. That result proves the settings loaded, the key parsed, and the database connected at startup.

If you get `{"error":"service is not configured"}`, read the reason in the runtime log:

```bash
vercel logs parmana-connectors.vercel.app --json
```

Find the entry with `service_not_configured`. Its `reason` names the first missing or invalid setting. Fix that setting (Step 5), redeploy, and check again.

**Check the Razorpay path** (test mode, from your machine, with a `rzp_test_` key in `.env`):

```bash
node --env-file-if-exists=.env src/connectors/razorpay/test-run.mjs
```

Expected: `4 of 4 checks passed`.

## Confirm which commit is live

The health and execute checks show that the service runs. They do not show which commit it was built from. To check that, read the build log of the production deployment.

Run these on your own machine, logged in to Vercel. In PowerShell, from the repository folder:

```powershell
vercel ls parmana-connectors --prod
vercel inspect https://<newest-production-url> --logs
```

Use the URL in the top row of the `vercel ls` output, which is the newest production deployment. In the log, the first lines name the commit Vercel cloned:

```
Cloning github.com/pavancharak/parmana-connectors (Branch: main, Commit: <sha>)
```

Compare `<sha>` with the current `main`. Fetch it first, then look at the short hash:

```bash
git fetch origin main
git rev-parse --short origin/main
```

If `<sha>` is the same commit as `origin/main`, the live service is current.

If `main` has moved on, a merge after that build started would have started a newer build. Check the newest deployment with `vercel ls`. If it has not reached `Ready`, or it failed, look at it on the **Deployments** page in the Vercel dashboard.

**Notes**

- `vercel inspect <url> --json` does not include the commit. Use `--logs`, as above.
- The build log can show a `TS2688` warning. It is a known warning, and the deployment still succeeds.

## Step 7: make a change and ship it

**1. Branch from `main` (Step 1 rules).**

```bash
git fetch origin main
git checkout -B feat/<short-name> origin/main
```

**2. Make the change, then check it locally.** Run both before committing:

```bash
npm ci
npm run build
npm test
```

Expected: the build exits without errors, and tests report no failures. The count of passed and skipped tests may change as tests are added. The 3 PostgreSQL tests are skipped unless `PARMANA_TEST_DATABASE_URL` is set. CI sets it.

For a change to `api/`, also run the adapter tests:

```bash
npx vitest run tests/api
```

**3. Commit and push** (Step 1 commands), with a message that says what changed and why.

**4. Open a pull request** with the GitHub connector or on GitHub. Describe what changed, why, the checks run, and anything not verified. The `parmana-connectors` repository has no pull request template.

**5. Wait for the preview.** Vercel builds a preview for every push. In the pull request, the **Vercel** check links to the deployment. Check it:

```bash
vercel inspect <preview-url-from-the-check> --logs
```

Expected: status `Ready`. Then check the preview's health route with `vercel curl` (Step 6). Preview deployments use the Preview environment, which has no variables unless you set them. An unset variable makes `/api/execute` answer `service is not configured`, which is expected for previews.

**6. Merge.** Merge the pull request into `main` only after the preview is `Ready`. Merging starts the Production deployment.

**7. Verify Production.** Run the Step 6 checks against `https://parmana-connectors.vercel.app`.

**Never** push an empty commit to re-run a check. Fix the cause, or re-run the failed job.

## Troubleshooting

Each row is an error seen while building this deployment, with its cause and fix.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `printf` is not recognized (PowerShell) | `printf` is a Linux command | Use the interactive prompt: run `vercel env add <NAME> production` and type the value |
| `Value contains newlines` when piping a PEM | The Vercel CLI rejects multi-line values from a pipe | Enter the key on one line with `\n` for each line break (Step 5) |
| `A variable with the name ... already exists` | The variable was already set | Check with `vercel env ls production`. Then `vercel env rm <NAME> production` and add it again |
| `/api/health` returns `NOT_FOUND` | Vercel routes come from files. Only `api/execute.ts` existed | Add `api/health.ts`, which exports the health handler (merged in PR #7) |
| Build fails: `STATIC_BUILD_NO_OUT_DIR` (no `public`) | The build ran, and Vercel expected a `public/` folder | Keep `public/index.html` on the branch, and set the output directory to `public` |
| Build log shows `TS2688 Cannot find type definition file for 'node'` | Vercel's compile of `api/` cannot find the Node types. Cause not confirmed | Not blocking: the deployment still reaches `Ready`. Fix in its own PR |
| `Can't find the deployment "dpl_..."` | The ID typed was wrong | Use the deployment URL: `vercel inspect <url> --logs` |
| Deployment URL shows `Protected by Vercel Authentication` (302) | Deployment protection is on | Use `vercel curl <url>/api/...`, which uses the project's bypass token |
| `{"error":"service is not configured"}` | A required setting is missing or invalid | Read the `reason` in `vercel logs <host> --json`, fix that variable, redeploy |
| Log reason: `RAZORPAY_KEY_PAIR is required` | The connector's credential is required at startup | Add `RAZORPAY_KEY_PAIR` (a test key) to Production, then redeploy |
| `unable to delete ...: remote ref does not exist` | The command ran in the wrong repository | Run `git remote get-url origin`, change folder, and run it again |
| `Everything up-to-date` after `git push --delete` | The branch was already deleted, or the delete did not run | Check with `git ls-remote --heads origin <branch>`. If it still lists the branch, run the delete on your own machine |
| A Production deployment from an old commit appears and fails | **Redeploy** was used on an old deployment | Nothing live changed, because a failed deployment does not replace the production domain. Redeploy `main`, not an old commit |

## Recovering a release that was recorded but not confirmed

Use this when a release was recorded and the answer is unclear. Examples: the service answered `connector failed: upstream_error` or `connector failed: timeout`, the process stopped during a refund, or a release is refused with `this businessTransactionId was already executed` and no answer reached you.

The service records a release before it runs the connector. A release that has been recorded cannot run again, so resending it does nothing. Whether a refund exists is a question for Razorpay, and only Razorpay can answer it.

**Rules**

- Do not resend the same release. The service refuses it.
- Do not delete rows from `parmana_connectors_nonces` to make a release run again. That is a decision for the owner, not a step in this runbook.
- Do not paste the key pair, the connection string or any secret into chat.

**Steps**

1. **Find the transaction id.** Read the runtime log and find the `connector_failed` or `release_answered` line for the release. It shows `businessTransactionId`, the error code, and the connector's message (`detail`). The message says whether a refund may exist. It does not show the payment id. Get the payment id (`pay_...`) from the parmana-core record of the action.

   ```bash
   vercel logs parmana-connectors.vercel.app --json
   ```

2. **Check the replay record (read only).** In the Supabase project `parmana-connectors`, open the SQL editor and run this, replacing the placeholder. Do not use the `parmana-sandbox` project.

   ```sql
   SELECT nonce, expires_at FROM parmana_connectors_nonces WHERE nonce = 'release:<businessTransactionId>';
   ```

   A row means the release was recorded. No row means either the connector never ran, or the row was removed after it expired. Rows are deleted by the service when it checks a later release, once they are more than 5 minutes past `expires_at`. So an old row can be missing even though a refund was made. Step 3 decides which.

3. **Check Razorpay for a refund with that receipt.** Each refund made by the connector carries the `businessTransactionId` as its receipt. In the Razorpay Dashboard, in the mode the key belongs to, open the payment and look at its refunds. Or, from your own machine with the key in an environment variable (never pasted), replace `<pay_id>` and run:

   ```bash
   curl -s -u "$RAZORPAY_KEY_PAIR" "https://api.razorpay.com/v1/payments/<pay_id>/refunds?count=100&skip=0"
   ```

   Look for `"receipt":"<businessTransactionId>"`. Each page holds 100 refunds, so change `skip` to `100`, `200` and so on until a page comes back short. The connector reads at most 1,000 refunds; a payment with more needs the Dashboard.

4. **Decide, and record the decision.**
   - **A refund with that receipt exists.** The refund was made. Record it in the business record. Do not resend. The refusal is correct.
   - **No refund with that receipt exists.** No refund was made, as far as Razorpay shows. Tell the owner before anything else. Then raise a new action in parmana-core under a new `businessTransactionId`, following its approval process. Production needs two people (maker and checker).
   - **Razorpay cannot be reached, or the answer is unclear.** Wait, and check again. Do not act on a guess.

After a row has been removed, the service would accept a release with the same `businessTransactionId` again. Step 3 is then the only guard, so never send an old `businessTransactionId` after its row has gone.

## Rollback, cleanup and the command summary

**Rollback.** Vercel keeps earlier deployments. To return Production to an earlier, working deployment, open it in **Deployments**, choose **… → Promote to Production** (or **Redeploy** for the same effect), and check Step 6 again. Then fix `main` by a normal pull request. Do not revert history on `main`.

**Cleanup of remote branches.** Delete a branch only after its pull request is merged. Check first:

```bash
git merge-base --is-ancestor origin/<branch> origin/main && echo merged
```

Then delete it:

```bash
git push origin --delete <branch>
```

A merged branch may already be removed automatically. Confirm with `git ls-remote --heads origin`.

**Command summary**

| Purpose | Command |
| --- | --- |
| Log in / link the folder | `vercel login`, `vercel link` |
| Health check | `vercel curl https://parmana-connectors.vercel.app/api/health` |
| Execute check | `vercel curl https://parmana-connectors.vercel.app/api/execute -- -X POST -H "Content-Type: application/json" -d "{}"` |
| Runtime log with reasons | `vercel logs parmana-connectors.vercel.app --json` |
| Build log | `vercel inspect <deployment-url> --logs` |
| List variable names | `vercel env ls production` |
| Add a variable | `vercel env add <NAME> production` |
| Remove a variable | `vercel env rm <NAME> production` |
| Test-mode Razorpay checks | `node --env-file-if-exists=.env src/connectors/razorpay/test-run.mjs` |
| Fetch Parmana's public key | `curl -s https://parmana-api-real.vercel.app/keys/default` |
| Run tests before a push | `npm ci && npm run build && npm test` |
| Delete a merged remote branch | `git push origin --delete <branch>` |

For the variable list and placeholders, see `SETUP.md` in `parmana-connectors`.
