# parmana-connectors

Vendor connectors for [Parmana](https://github.com/pavancharak/parmana-core). Each connector runs outside parmana-core as an external connector service. It receives a signed release from Parmana, verifies it, performs the action with its own credentials, and returns the result.

## Layout

| Path | Contents |
| --- | --- |
| `src/connector.ts` | The connector interface and the generic manifest connector |
| `src/manifest.ts`, `schema/manifest.schema.json` | Manifest loading and validation |
| `src/connectors/<vendor>/` | One folder per vendor |
| `tests/connectors/` | Tests for each vendor, against a fake of the vendor's API |

## Connectors

| Connector | Capability | Status |
| --- | --- | --- |
| Razorpay | `razorpay:refund` | Test mode by default. Live keys are refused unless explicitly allowed. |

## Commands

```bash
npm ci
npm run build
npm test
```

Requires Node.js 24 or later.
