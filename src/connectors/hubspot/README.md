# HubSpot connector

Two capabilities on a deal. It is the HubSpot connector moved from parmana-core under ADR-0018.

- **`hubspot:deal-fetch`** reads the deal's `dealstage`, `amount` and `pipeline`.
- **`hubspot:deal-update`** sets `dealstage` and/or `amount`, and nothing else.

- **Code:** `hubspot-connector.ts` in this folder. It imports only Node built-ins and the shared contract.
- **Credential:** `HUBSPOT_PRIVATE_APP_TOKEN`, a Private App token, sent only as a bearer header. Errors and results show only a fingerprint of it.
- **Deal id:** `dealId` must be digits, and it must equal the release target when the release names one.
- **Parameters:** only the ones listed above are allowed for each capability. Any other is refused before a call.
- **Repeats:** an update sets final values, so a repeat leaves the deal in the same state. Nothing is incremented.
- **Checks:** tests use a fake HubSpot, in `tests/connectors/hubspot/`. The request shapes are the in-core connector's and have not been checked against a live HubSpot portal.

If an update may have reached HubSpot and no answer was read, the error says to check the deal before any other action.
