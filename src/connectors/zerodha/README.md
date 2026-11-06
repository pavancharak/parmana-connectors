# Zerodha connector (paper mode only)

A connector that validates a Kite Connect order and records it as a simulated order. It does not send anything to a broker. It is not registered with the service, and it has no live mode.

> **Status:** Paper mode only. Live trading is not part of this repository. See [Not covered](#not-covered).

## Capability

| Capability | Policy | What it does |
|---|---|---|
| `zerodha:place-order` | None. The connector is not registered with the service, so no policy applies. | Validates an order and records it as simulated. |

## What it does

- **Validates** the order against the rules below. A refused order is never recorded.
- **Records** a valid order as a simulated order, in memory, for this connector instance.
- **Sends nothing.** It makes no network calls, and no broker is contacted.

Orders are held in memory only. A restart clears them, and nothing is saved to disk.

## Parameters

Any parameter other than these is refused before validation:

| Parameter | Required | Rules |
|---|---|---|
| `tradingsymbol` | Yes | A non-empty string |
| `exchange` | Yes | One of `NSE`, `BSE`, `NFO`, `CDS`, `MCX` |
| `transactionType` | Yes | `BUY` or `SELL` |
| `quantity` | Yes | A positive whole number |
| `orderType` | Yes | One of `MARKET`, `LIMIT`, `SL`, `SL-M` |
| `product` | Yes | One of `CNC`, `MIS`, `NRML` |
| `variety` | No | Only `regular` |
| `price` | Required for `LIMIT` and `SL` | A positive number |
| `triggerPrice` | Required for `SL` and `SL-M` | A positive number |

## Architecture

- **Code:** `zerodha-connector.ts` in this folder. It imports only the shared contract.
- **Tests:** `tests/connectors/zerodha/`. They assert that no network call is made.

## Not covered

- **No live mode.** Live trading needs a SEBI circular review and Zerodha's written API approval. Neither is in this repository, so this connector cannot place a real order.
- **Not registered.** The service does not load this connector. Paper mode needs no credential, but the service requires one for each registered connector.
- **No policy.** Since the connector is not registered, no approval policy applies to it.

## Before any live use

Live use would need, at minimum:

1. A SEBI circular review of the intended activity.
2. Zerodha's written approval for the Kite Connect API use.
3. A new live client, a credential, and a policy with signed approvals.
4. A separate decision to enable live mode, recorded in the repository.

None of these exist yet.

## Operations

There is nothing to operate in paper mode. Do not add a credential or register the connector with the service until the steps above are complete.

## Contributing and security

Read `CONTRIBUTING.md` before you open a pull request. Report vulnerabilities privately, as described in `SECURITY.md`. Do not open a public issue for them.
