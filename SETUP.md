# Vercel setup for parmana-connectors

This file records how the Vercel project is set up. It holds no secret values. Where a value is secret, the table gives a placeholder and the place to get it.

## Project

| Item | Value |
| --- | --- |
| Vercel team | pavan-dev-singh-charaks-projects |
| Vercel project | parmana-connectors |
| Git repository | pavancharak/parmana-connectors |
| Production branch | main |
| Preview | every other branch |
| Production URL | https://parmana-connectors.vercel.app |
| Framework preset | Other |
| Build command | override set to `echo "no static build"`; the TypeScript build is not run on Vercel |
| Output directory | `public` (contains a placeholder page) |
| Install command | `npm ci` |
| Node.js | 24.x |

The functions are `api/execute.ts` (served at `/api/execute`) and `api/health.ts` (served at `/api/health`). Vercel compiles them from `api/`.

## Environment variables (Production)

| Name | Type | Value | Where the value comes from |
| --- | --- | --- | --- |
| `PARMANA_CONNECTOR` | Secret | `razorpay` | Fixed |
| `PARMANA_ALLOW_LIVE_KEYS` | Secret | `false` | Fixed. Stays `false` until live use is approved |
| `PARMANA_NONCE_STORE` | Secret | `postgres` | Fixed |
| `PARMANA_PUBLIC_KEY` | Config | One line, PEM text, with `\n` for line breaks: `-----BEGIN PUBLIC KEY-----\n<base64 key>\n-----END PUBLIC KEY-----` | The `pem` field of `https://parmana-api-real.vercel.app/keys/default`. The key is public. Config type, so it can be revealed in the dashboard |
| `PARMANA_RELEASE_AUDIENCE` | Secret | `https://parmana-connectors.vercel.app/api/execute` | Must match the URL registered for this endpoint in parmana-core |
| `PARMANA_DATABASE_URL` | Secret | `postgresql://<user>:<PASSWORD>@<host>:6543/postgres` (placeholder) | Supabase project `parmana-connectors`, Connect page, Transaction pooler string, with the database password filled in. Do not use the `parmana-sandbox` project, which is production's database |
| `SLACK_BOT_TOKEN` | Secret | `xoxb-<TOKEN>` (placeholder). Needed only when `PARMANA_CONNECTOR=slack` | Slack app settings, OAuth and Permissions, bot token. Use a test workspace until live use is approved |
| `GITHUB_APP_CREDENTIAL` | Secret | `<APP_ID>:<INSTALLATION_ID>:<BASE64_PEM>` (placeholder). Needed only when `PARMANA_CONNECTOR=github` | GitHub App settings: its id, a generated private key, and the installation id. Use a test repository until live use is approved |
| `PAYTM_MERCHANT_CREDENTIAL` | Secret | `<MERCHANT_ID>:<MERCHANT_KEY>` (placeholder). Needed only when `PARMANA_CONNECTOR=paytm`. Staging credentials only | Paytm Dashboard, staging. Use staging only until production use is approved |
| `RAZORPAY_KEY_PAIR` | Secret | `rzp_test_<KEY_ID>:<KEY_SECRET>` (placeholder) | Razorpay Dashboard, test mode, API Keys. Use a test key only until live use is approved |

Leave these unset:

- `PARMANA_PUBLIC_KEY_FILE`. It must not be set together with `PARMANA_PUBLIC_KEY`.
- `PARMANA_CONNECTOR_TIMEOUT_MS`. The default of 10000 ms applies.
- `PARMANA_SERVICE_PORT` and `PARMANA_SERVICE_HOST`. Vercel does not use them.

## Setting a variable

Run from the repository folder. Each command prompts for the value, so the value is not written into the command:

```powershell
vercel env add PARMANA_CONNECTOR production
vercel env add PARMANA_ALLOW_LIVE_KEYS production
vercel env add PARMANA_NONCE_STORE production
vercel env add PARMANA_PUBLIC_KEY production
vercel env add PARMANA_RELEASE_AUDIENCE production
vercel env add PARMANA_DATABASE_URL production
vercel env add RAZORPAY_KEY_PAIR production
```

To list names and types without values:

```powershell
vercel env ls production
```

Secret values cannot be read back. To change one, remove it and add it again:

```powershell
vercel env rm <NAME> production
```

Environment changes apply to new deployments only. Redeploy `main` after any change.

## Rules

- Never commit a value, a `.env` file or a key pair to the repository.
- Never paste a secret into chat, a document or a log.
- Keep `PARMANA_ALLOW_LIVE_KEYS` at `false` until live use is approved.
- Keep `RAZORPAY_KEY_PAIR` on a test key until live use is approved.
