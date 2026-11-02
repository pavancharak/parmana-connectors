# Zerodha connector (paper mode only)

`zerodha:place-order` validates a Kite Connect order and records it as a simulated order. It is the Zerodha connector from parmana-core, moved under ADR-0018. Core never registered it, and its live path was never enabled.

- **Code:** `zerodha-connector.ts` in this folder. It imports only the shared contract.
- **Paper only:** it makes no network calls and sends nothing to a broker. Orders are kept in memory only, and nothing is saved.
- **No live mode:** live trading is not in this repository. Core's live client needed a SEBI circular review and Zerodha's written API approval, and nothing supplied them. This connector has no live option, so it cannot place a real order.
- **Not registered:** paper mode needs no credential, and the service requires one per connector. The connector is not wired into the service, the same as in core.
- **Validation:** exchange (NSE, BSE, NFO, CDS, MCX), transaction type (BUY, SELL), positive whole quantity, order type (MARKET, LIMIT, SL, SL-M), product (CNC, MIS, NRML), `variety` only `regular`, and the price and trigger price each order type needs. Any other parameter is refused.
- **Checks:** tests are in `tests/connectors/zerodha/`. They assert that no network call happens.
