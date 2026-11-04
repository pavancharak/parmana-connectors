import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import {
  ZOHO_INVOICE_CREATE_CAPABILITY,
  ZOHO_INVOICE_FETCH_CAPABILITY,
  createZohoConnector,
  parseZohoAccessToken,
  parseZohoOrganizationId,
  zohoTokenFingerprint,
} from "../../../src/connectors/zoho/zoho-connector.js";

const TOKEN = "fake-zoho-access-token-for-tests";
const ORG = "700000001";
const INVOICE = "460000000012345";
const CUSTOMER = "460000000054321";
const TXN = "3b8f4c1e-2a7d-4e9b-9c6f-1d2e3f4a5b6c";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly organization: string | null;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

/** A fake Zoho Books. `json` is the body it returns, `status` the HTTP status, `fail` makes the call throw. */
function fakeZoho(options: { json?: unknown; status?: number; fail?: boolean; rawText?: string } = {}) {
  const sent: Sent[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({
      method: String(init?.method),
      path: url.pathname,
      organization: url.searchParams.get("organization_id"),
      authorization: headers["authorization"],
      body,
    });
    if (options.fail) throw new Error("socket reset");
    const text = options.rawText ?? JSON.stringify(options.json ?? { code: 0, message: "success", invoice: invoiceBody() });
    return new Response(text, { status: options.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, sent };
}

function invoiceBody() {
  return {
    invoice_id: INVOICE,
    invoice_number: "INV-000001",
    status: "sent",
    customer_id: CUSTOMER,
    reference_number: TXN,
    total: 1500,
    currency_code: "USD",
  };
}

function fetchRequest(parameters: Record<string, unknown> = {}, target: string | undefined = INVOICE): ConnectorRequest {
  return { capability: ZOHO_INVOICE_FETCH_CAPABILITY, parameters: { invoiceId: INVOICE, ...parameters }, target, businessTransactionId: TXN };
}

function createRequest(parameters: Record<string, unknown> = {}, transactionId: string | undefined = TXN): ConnectorRequest {
  return {
    capability: ZOHO_INVOICE_CREATE_CAPABILITY,
    parameters: {
      customerId: CUSTOMER,
      lineItems: [{ name: "Consulting", rate: 150, quantity: 10 }],
      ...parameters,
    },
    businessTransactionId: transactionId,
  };
}

function context(value: string = TOKEN): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "ZOHO_ACCESS_TOKEN", value }, timeoutMs: 5_000 };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as ConnectorError).code;
  }
  throw new Error("expected a ConnectorError");
}

describe("zoho connector: credential and organization", () => {
  it("accepts an access token", () => {
    expect(parseZohoAccessToken(TOKEN)).toBe(TOKEN);
  });

  it("refuses an empty token or one with spaces, without showing it", () => {
    expect(() => parseZohoAccessToken("")).toThrow(ConnectorError);
    try {
      parseZohoAccessToken("bad token value");
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).code).toBe("credential_invalid");
      expect((error as ConnectorError).message).not.toContain("bad token");
    }
  });

  it("accepts a digits-only organization id and refuses anything else", () => {
    expect(parseZohoOrganizationId(ORG)).toBe(ORG);
    expect(() => parseZohoOrganizationId(undefined)).toThrow(ConnectorError);
    expect(() => parseZohoOrganizationId("700 000")).toThrow(ConnectorError);
    expect(() => createZohoConnector({ organizationId: "" })).toThrow(ConnectorError);
  });

  it("gives a fingerprint that is not a piece of the token", () => {
    expect(zohoTokenFingerprint(TOKEN)).toMatch(/^fp_[0-9a-f]{12}$/);
    expect(TOKEN).not.toContain(zohoTokenFingerprint(TOKEN));
  });
});

describe("zoho connector: zoho:invoice-fetch", () => {
  it("reads the invoice with the Zoho auth header and the organization id", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    const result = await connector.execute(fetchRequest(), context());

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.method).toBe("GET");
    expect(fake.sent[0]?.path).toBe(`/books/v3/invoices/${INVOICE}`);
    expect(fake.sent[0]?.organization).toBe(ORG);
    expect(fake.sent[0]?.authorization).toBe(`Zoho-oauthtoken ${TOKEN}`);
    expect(result.metadata.status).toBe(200);
    expect(result.metadata.body).toMatchObject({ invoice: { invoiceId: INVOICE, status: "sent", total: 1500 } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("refuses an invoice id that is not digits, before any call", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute(fetchRequest({ invoiceId: "../other" }, undefined), context()))).toBe("invalid_input");
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses an invoice that differs from the release target", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute(fetchRequest({}, "460000000099999"), context()))).toBe("invalid_input");
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a parameter the capability does not allow", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute(fetchRequest({ status: "void" }), context()))).toBe("invalid_input");
    expect(fake.sent).toHaveLength(0);
  });
});

describe("zoho connector: zoho:invoice-create", () => {
  it("creates an invoice and writes the transaction id as its reference number", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    const result = await connector.execute(createRequest(), context());

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.method).toBe("POST");
    expect(fake.sent[0]?.path).toBe("/books/v3/invoices");
    expect(fake.sent[0]?.body).toEqual({
      customer_id: CUSTOMER,
      reference_number: TXN,
      line_items: [{ name: "Consulting", rate: 150, quantity: 10 }],
    });
    expect(result.metadata.status).toBe(201);
    expect(result.metadata.body).toMatchObject({ invoice: { invoiceId: INVOICE, referenceNumber: TXN } });
  });

  it("refuses a create without a businessTransactionId, before any call", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    const withoutTransaction: ConnectorRequest = {
      capability: ZOHO_INVOICE_CREATE_CAPABILITY,
      parameters: { customerId: CUSTOMER, lineItems: [{ name: "Consulting", rate: 150, quantity: 10 }] },
    };
    expect(await codeOf(connector.execute(withoutTransaction, context()))).toBe("invalid_input");
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses an empty or oversized line item list", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute(createRequest({ lineItems: [] }), context()))).toBe("invalid_input");
    expect(await codeOf(connector.execute(createRequest({ lineItems: Array(51).fill({ name: "x", rate: 1, quantity: 1 }) }), context()))).toBe("invalid_input");
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a line item with an unknown field, a bad rate or a zero quantity", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute(createRequest({ lineItems: [{ name: "x", rate: 1, quantity: 1, tax: 5 }] }), context()))).toBe("invalid_input");
    expect(await codeOf(connector.execute(createRequest({ lineItems: [{ name: "x", rate: -1, quantity: 1 }] }), context()))).toBe("invalid_input");
    expect(await codeOf(connector.execute(createRequest({ lineItems: [{ name: "x", rate: 1, quantity: 0 }] }), context()))).toBe("invalid_input");
    expect(fake.sent).toHaveLength(0);
  });

  it("says to check for the reference when the create may have reached Zoho", async () => {
    const fake = fakeZoho({ fail: true });
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    try {
      await connector.execute(createRequest(), context());
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).code).toBe("upstream_error");
      expect((error as ConnectorError).message).toContain("reference number");
    }
  });

  it("treats a non-zero Zoho code on an HTTP 200 as a refusal", async () => {
    const fake = fakeZoho({ json: { code: 9001, message: "Customer not found" } });
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute(createRequest(), context()))).toBe("upstream_error");
  });
});

describe("zoho connector: upstream failures", () => {
  it("reports a non-JSON answer as an upstream error", async () => {
    const fake = fakeZoho({ rawText: "<html>gateway</html>" });
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute(fetchRequest(), context()))).toBe("upstream_error");
  });

  it("reports HTTP errors without the token", async () => {
    const fake = fakeZoho({ status: 401, json: { code: 57, message: "invalid token" } });
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    try {
      await connector.execute(fetchRequest(), context());
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).message).toContain("HTTP 401");
      expect((error as ConnectorError).message).not.toContain(TOKEN);
    }
  });

  it("rejects an unknown capability", async () => {
    const fake = fakeZoho();
    const connector = createZohoConnector({ organizationId: ORG, fetch: fake.fetch });
    expect(await codeOf(connector.execute({ capability: "zoho:invoice-delete", parameters: {} }, context()))).toBe("unknown_capability");
  });
});
