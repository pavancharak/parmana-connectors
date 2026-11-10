# Razorpay connector: test-mode demo

This guide covers the `razorpay:refund` connector in this folder. It explains what is ready, what is not, and how to run the test-mode check on your own machine.

Test-mode refunds move no money. Live money is switched off in this repository.

## What is ready

| Part | File | State |
| --- | --- | --- |
| Connector | `razorpay-connector.ts` | Built and unit-tested against a fake Razorpay |
| Refund once | `razorpay-connector.ts` | Looks for an earlier refund with the same receipt before refunding, so a repeat returns the existing refund |
| Refusals before any call | `razorpay-connector.ts` | Wrong target, zero or fractional amount, missing transaction ID, and live keys (unless enabled) are refused without calling Razorpay |
| Test-mode check | `test-run.mjs` | Runs 4 checks against Razorpay test mode. Last passing run: 10 November 2026, 4 of 4 |
| Reference | `README.md` | Request format, credential format, answer fields and error codes |

The 4 checks are:

1. A refund is created once.
2. A repeat with the same transaction returns the same refund and creates no second one.
3. A target that is not a payment ID is refused.
4. A zero amount is refused.

## What is not ready

- **Claude cannot trigger a refund yet.** The Razorpay connector in claude.ai is read-only: it can look up payments and refunds, but it cannot create one. The refund runs only through `test-run.mjs` or the Parmana service.
- **No end-to-end signed release has been run** through the deployed service. The release path (parmana-core signs, this service verifies and acts) is built but not yet exercised with Razorpay.
- **Live mode is off.** `rzp_live_` keys are refused unless `PARMANA_ALLOW_LIVE_KEYS=true`. No live run is recorded.
- **Limits.** The repeat check reads at most 1,000 refunds on one payment. A payment with more is refused, not refunded.
- **Rate limits.** Razorpay returns HTTP 429 if you call it too often. If that happens, wait a few minutes and run again. A 429 on the list step creates no refund.

## Before you start

You need:

- Node.js 24 or later (`node -v`)
- A Razorpay **test** key pair, starting with `rzp_test_`. Create it in the Razorpay Dashboard with Test Mode on, under Account & Settings → API Keys.
- A **captured test payment** ID, starting with `pay_`. Create it in test mode using Razorpay's test card or UPI details.

Keep the key secret out of chat, commits and screenshots.

## Run it: Windows PowerShell

Run each line on its own. PowerShell does not accept `&&`.

```powershell
cd D:\path\to\parmana-connectors
git checkout claude/elegant-hypatia-wy5oqu
npm ci
npm run build
$env:RAZORPAY_KEY_PAIR = "rzp_test_<key id>:<key secret>"
$env:RAZORPAY_TEST_PAYMENT_ID = "pay_<your test payment id>"
node src/connectors/razorpay/test-run.mjs
```

Expected output ends with `4 of 4 checks passed.`

The two `$env:` lines last only for this PowerShell window. Your PowerShell history keeps them, so clear that history or close the window afterwards.

## Run it: macOS or Linux

```bash
cd /path/to/parmana-connectors
git checkout claude/elegant-hypatia-wy5oqu
npm ci
npm run build
export RAZORPAY_KEY_PAIR="rzp_test_<key id>:<key secret>"
export RAZORPAY_TEST_PAYMENT_ID="pay_<your test payment id>"
node src/connectors/razorpay/test-run.mjs
```

Expected output ends with `4 of 4 checks passed.`

## Optional: keep the settings in a `.env` file

Create `.env` in the repository root. It is git-ignored, so it is not committed. Do not commit it.

```
RAZORPAY_KEY_PAIR=rzp_test_<key id>:<key secret>
RAZORPAY_TEST_PAYMENT_ID=pay_<your test payment id>
```

Then run:

```bash
node --env-file-if-exists=.env src/connectors/razorpay/test-run.mjs
```

## Reading the output

| Output | Meaning | Action |
| --- | --- | --- |
| `Refused: RAZORPAY_KEY_PAIR must be a test key` | The key is missing, blank, or not `rzp_test_` | Set the key, or check `.env` for blank values |
| `Refused: RAZORPAY_TEST_PAYMENT_ID must be...` | The payment ID is missing or not `pay_...` | Set a captured test payment ID |
| `FAIL refund is created once: upstream_error ... HTTP 429` | Razorpay rate limit | Wait a few minutes and run again |
| `4 of 4 checks passed.` | All checks passed | Confirm the refund in the Razorpay test dashboard |

The script never prints the key. A failed run that stops at the list step creates no refund.

## Confirm the refund

The script prints a refund ID such as `rfnd_...`. Find it in the Razorpay Dashboard in test mode, under Refunds. Its status should be `Refund Processed`.

## Clean up

- Delete `.env` if you created it.
- Delete the `RAZORPAY_KEY_PAIR` value from any shell or history where you typed it.
- Do not reuse a test key in a live setting.
