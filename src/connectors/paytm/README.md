# Paytm refund connector

`paytm:refund` refunds one already-charged Paytm transaction, once. It is the Paytm connector moved from parmana-core under ADR-0018.

- **Code:** `paytm-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Credential:** `PAYTM_MERCHANT_CREDENTIAL`, `<merchant id>:<merchant key>`. The key must be exactly 16 bytes. Its value is never shown in an error.
- **Environment:** staging only. The service never selects production Paytm, even with `PARMANA_ALLOW_LIVE_KEYS=true`. Production needs its own setting and approval.
- **Act once:** before a refund is sent, the connector asks Paytm for the refId's status. A confirmed refund is returned, not sent again. A pending refund is refused.
- **Success:** only `S`, `SUCCESS` and `TXN_SUCCESS` count. `PENDING` is never reported as success.
- **Parameters:** `orderId`, `transactionId`, `amount` (rupees, at most two decimals), and the optional `refundReason` (256 characters at most) and `refundReference` (128 characters at most). Any other parameter is refused before a call.
- **Checks:** the request and response shapes are taken from `parmana-paytm-agent`. They have not been checked against a live Paytm account. Tests use a fake Paytm, in `tests/connectors/paytm/`.

Failures after the refund may have reached Paytm say to check Paytm before any other action.
