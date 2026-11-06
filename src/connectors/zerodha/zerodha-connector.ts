import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector-contract.js";

/**
 * A paper-mode connector for Zerodha Kite orders. It validates an order and
 * records it as a simulated order. It makes no network calls and sends nothing
 * to any broker.
 *
 * Live trading is not in this repository. Core's live client needed a SEBI
 * circular review and Zerodha's written API approval, and nothing supplied
 * them. This connector has no live mode, so it cannot place a real order.
 *
 * The connector is not registered with the service. Paper mode needs no
 * credential, and the service requires one per connector. Core has never
 * registered Zerodha either.
 */

export const ZERODHA_PLACE_ORDER_CAPABILITY = "zerodha:place-order";

const PARAMETERS: ReadonlySet<string> = new Set(["tradingsymbol", "exchange", "transactionType", "quantity", "orderType", "product", "variety", "price", "triggerPrice"]);
const EXCHANGES: ReadonlySet<string> = new Set(["NSE", "BSE", "NFO", "CDS", "MCX"]);
const ORDER_TYPES: ReadonlySet<string> = new Set(["MARKET", "LIMIT", "SL", "SL-M"]);
const PRODUCTS: ReadonlySet<string> = new Set(["CNC", "MIS", "NRML"]);

export interface PaperOrder {
  readonly tradingsymbol: string;
  readonly exchange: string;
  readonly transactionType: "BUY" | "SELL";
  readonly quantity: number;
  readonly orderType: string;
  readonly product: string;
  readonly price?: number;
  readonly triggerPrice?: number;
}

export interface PaperOrderRecord {
  readonly orderId: string;
  readonly status: "PAPER_ACCEPTED";
  readonly order: PaperOrder;
}

function refuse(message: string): never {
  throw new ConnectorError("invalid_input", message);
}

function requireText(parameters: Readonly<Record<string, unknown>>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.trim() === "") refuse(`${key} must be a non-empty string.`);
  return value.trim();
}

function optionalPositive(parameters: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !(value > 0) || !Number.isFinite(value)) refuse(`${key} must be a positive number.`);
  return value;
}

/** Validates the order the way core's paper client did. Throws ConnectorError with the field that failed. */
export function validatePaperOrder(parameters: Readonly<Record<string, unknown>>): PaperOrder {
  for (const name of Object.keys(parameters)) {
    if (!PARAMETERS.has(name)) refuse(`Parameter "${name}" is not allowed for zerodha:place-order.`);
  }

  const tradingsymbol = requireText(parameters, "tradingsymbol");
  const exchange = requireText(parameters, "exchange");
  if (!EXCHANGES.has(exchange)) refuse("exchange is not a supported exchange.");

  const transactionType = requireText(parameters, "transactionType");
  if (transactionType !== "BUY" && transactionType !== "SELL") refuse("transactionType must be BUY or SELL.");

  const quantity = parameters["quantity"];
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) refuse("quantity must be a positive integer.");

  const orderType = requireText(parameters, "orderType");
  if (!ORDER_TYPES.has(orderType)) refuse("orderType is not a supported order type.");

  const product = requireText(parameters, "product");
  if (!PRODUCTS.has(product)) refuse("product is not a supported product.");

  const variety = parameters["variety"];
  if (variety !== undefined && variety !== "regular") refuse('variety must be "regular".');

  const price = optionalPositive(parameters, "price");
  const triggerPrice = optionalPositive(parameters, "triggerPrice");
  if ((orderType === "LIMIT" || orderType === "SL") && price === undefined) refuse("price is required for this order type.");
  if ((orderType === "SL" || orderType === "SL-M") && triggerPrice === undefined) refuse("triggerPrice is required for this order type.");

  return {
    tradingsymbol,
    exchange,
    transactionType,
    quantity,
    orderType,
    product,
    ...(price !== undefined ? { price } : {}),
    ...(triggerPrice !== undefined ? { triggerPrice } : {}),
  };
}

export function createZerodhaPaperConnector(): GenericConnector {
  // Simulated orders for this connector instance. They live only in memory, and nothing is sent anywhere.
  const orders: PaperOrderRecord[] = [];
  let sequence = 0;

  return {
    system: "zerodha",
    capabilities: [ZERODHA_PLACE_ORDER_CAPABILITY],

    async execute(request: ConnectorRequest, _context: ConnectorExecutionContext): Promise<ConnectorResponse> {
      if (request.capability !== ZERODHA_PLACE_ORDER_CAPABILITY) {
        throw new ConnectorError("unknown_capability", `The Zerodha connector does not run "${request.capability}".`);
      }
      const order = validatePaperOrder(request.parameters);
      sequence += 1;
      const record: PaperOrderRecord = Object.freeze({
        orderId: `PAPER-${String(sequence).padStart(6, "0")}`,
        status: "PAPER_ACCEPTED",
        order: Object.freeze({ ...order }),
      });
      orders.push(record);
      return {
        success: true,
        metadata: { status: 200, body: { mode: "paper", orderId: record.orderId, status: record.status } },
      };
    },
  };
}
