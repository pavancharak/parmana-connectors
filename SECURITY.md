# Security policy

This repository runs the code that acts in business systems on Parmana's behalf. A weakness here can move money or change records, so report it privately.

## Reporting a vulnerability

Do not open a public issue or a public pull request for a security problem.

Report it through the contact in parmana-core's security policy: [parmana-core SECURITY.md](https://github.com/pavancharak/parmana-core/blob/main/SECURITY.md). That policy gives the reporting address, the acknowledgement time, and what to include.

Do not put a live credential, a key pair, a database connection string or a customer's data in a report. Describe the problem, its impact, and the steps to reproduce. If a credential has been exposed, say so at once, so it can be rotated.

## Scope

In scope, for this repository:

- Verification of signed releases, the replay store and the answers the service gives (`src/service/`, `api/`).
- The connectors, including the refusals they make before any call to a business system (`src/connectors/`).
- Configuration checks, including the rule that live keys are refused unless allowed.
- Anything that could make a credential appear in a log, an answer or an error.

Out of scope here: the policy engine and the signing side, which are in parmana-core, and the hosting platform itself.

## Secrets in this repository

Secrets are never committed. Production values are set only in Vercel, and local values only in a git-ignored `.env` file. See [SETUP.md](SETUP.md) and [RUNBOOK.md](src/connectors/razorpay/RUNBOOK.md) for where each value is kept.
