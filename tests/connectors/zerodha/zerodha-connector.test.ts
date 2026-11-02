import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import { ZERODHA_PLACE_ORDER_CAPABILITY, createZerodhaPaperConnector, validatePaperOrder } from "../../../src/connectors/zerodha/zerodha-connector.js";

const context: ConnectorExecutionContext = { credential: { providerId: "none", credentialId: "none", value: "" }, timeoutMs: 5_000 };

function order(overrides: Record<string, unknown> = {}): ConnectorRequest {
  return {
    capability: ZERODHA_PLACE_ORDER_CAPABILITY,
    parameters: { tradingsymbol: "INFY", exchange: "NSE", transactionType: "BUY", quantity: 10, orderType: "LIMIT", product: "CNC", price: 1500, ...overrides },
    businessTransactionId: "3b8f4c1e-2a7d-4e9b-9c6f-1d2e3f4a5b6c",
  };
}

describe("zerodha paper connector", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error("paper mode must not make a network call");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records a valid limit order as a simulated order, with no network call", async () => {
    const response = await createZerodhaPaperConnector().execute(order(), context);

    expect(response.success).toBe(true);
    expect(response.metadata.body).toEqual({ mode: "paper", orderId: "PAPER-000001", status: "PAPER_ACCEPTED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives each simulated order its own id, in sequence", async () => {
    const connector = createZerodhaPaperConnector();
    const first = await connector.execute(order(), context);
    const second = await connector.execute(order({ tradingsymbol: "TCS" }), context);
    expect(first.metadata.body).toMatchObject({ orderId: "PAPER-000001" });
    expect(second.metadata.body).toMatchObject({ orderId: "PAPER-000002" });
  });

  it("accepts a market order with no price", async () => {
    const response = await createZerodhaPaperConnector().execute(order({ orderType: "MARKET", price: undefined }), context);
    expect(response.success).toBe(true);
  });

  it("refuses a limit order without a price", async () => {
    await expect(createZerodhaPaperConnector().execute(order({ price: undefined }), context)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a stop-loss order without a trigger price", async () => {
    await expect(createZerodhaPaperConnector().execute(order({ orderType: "SL-M", price: undefined }), context)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses an unsupported exchange", () => {
    expect(() => validatePaperOrder(order({ exchange: "XYZ" }).parameters)).toThrow(ConnectorError);
  });

  it("refuses a quantity that is not a positive whole number", () => {
    expect(() => validatePaperOrder(order({ quantity: 0 }).parameters)).toThrow(/quantity/);
    expect(() => validatePaperOrder(order({ quantity: 1.5 }).parameters)).toThrow(/quantity/);
  });

  it("refuses a variety other than regular", () => {
    expect(() => validatePaperOrder(order({ variety: "amo" }).parameters)).toThrow(/variety/);
  });

  it("refuses a parameter that is not allowed", () => {
    expect(() => validatePaperOrder(order({ disclosedQuantity: 5 }).parameters)).toThrow(/not allowed/);
  });

  it("refuses another capability", async () => {
    await expect(createZerodhaPaperConnector().execute({ ...order(), capability: "zerodha:cancel" }, context)).rejects.toMatchObject({ code: "unknown_capability" });
  });

  it("has no live mode: the connector takes no approval or live option", () => {
    const connector = createZerodhaPaperConnector();
    expect(connector.capabilities).toEqual([ZERODHA_PLACE_ORDER_CAPABILITY]);
  });
});
