import { createHash } from "node:crypto";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector-contract.js";

/**
 * A connector for Zoho Books invoices. It has the same shape as the generic
 * connector, so the execution service can run either one.
 *
 * Two capabilities:
 * - `zoho:invoice-fetch` reads one invoice. Read-only.
 * - `zoho:invoice-create` creates one invoice for an approved customer.
 *
 * Only the parameters listed for each capability are sent to Zoho. Any other
 * parameter is refused before a call.
 *
 * Authentication is a Zoho OAuth access token, sent as `Zoho-oauthtoken`. It is
 * never returned to the caller. Results show only a fingerprint of it.
 *
 * Zoho has no idempotency key, so the Parmana businessTransactionId is written
 * to the invoice's `reference_number`. A create without it is refused. If a
 * create may have reached Zoho but no answer was read, the error tells the
 * operator to check for an invoice with that reference before retrying.
 */

export const ZOHO_INVOICE_FETCH_CAPABILITY = "zoho:invoice-fetch";
export const ZOHO_INVOICE_CREATE_CAPABILITY = "zoho:invoice-create";

/** The US data centre. Other Zoho data centres need their own base URL, which this connector does not yet support. */
const API = "https://www.zohoapis.com/books/v3";
const DEFAULT_BUDGET_MS = 10_000;
const FETCH_PARAMETERS: ReadonlySet<string> = new Set(["invoiceId"]);
const CREATE_PARAMETERS: ReadonlySet<string> = new Set(["customerId", "lineItems"]);
const MAX_LINE_ITEMS = 50;

export interface ZohoConnectorOptions {
  /** The Zoho Books organization id that every call is scoped to. Digits only. */
  readonly organizationId: string;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

/** A fingerprint of the token, safe to show. Never a substring of it. */
export function zohoTokenFingerprint(token: string): string {
  return `fp_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12)}`;
}

/** Reads the OAuth access token. Refuses an empty value or one with whitespace, without showing it. */
export function parseZohoAccessToken(value: string): string {
  const token = value.trim();
  if (token === "" || /\s/.test(token)) {
    throw new ConnectorError("credential_invalid", "The Zoho access token is empty or contains spaces. Its value is not shown.");
  }
  return token;
}

/** Reads the organization id. Refuses anything that is not digits, without showing it. */
export function parseZohoOrganizationId(value: string | undefined): string {
  if (value === undefined || !/^\d{1,30}$/.test(value)) {
    throw new ConnectorError("credential_invalid", "ZOHO_ORGANIZATION_ID must be the Zoho Books organization id (digits only). Its value is not shown.");
  }
  return value;
}

function refuse(message: string): never {
  throw new ConnectorError("invalid_input", message);
}

function requireInvoiceId(parameters: Readonly<Record<string, unknown>>, target: string | undefined): string {
  const invoiceId = parameters["invoiceId"];
  if (typeof invoiceId !== "string" || !/^\d{1,30}$/.test(invoiceId)) {
    refuse("invoiceId must be a Zoho invoice id (digits only).");
  }
  if (target !== undefined && target !== invoiceId) {
    refuse(`The invoice "${invoiceId}" is not the authorised target.`);
  }
  return invoiceId;
}

function requireCustomerId(parameters: Readonly<Record<string, unknown>>): string {
  const customerId = parameters["customerId"];
  if (typeof customerId !== "string" || !/^\d{1,30}$/.test(customerId)) {
    refuse("customerId must be a Zoho customer id (digits only).");
  }
  return customerId;
}

interface LineItem {
  readonly name: string;
  readonly rate: number;
  readonly quantity: number;
}

function requireLineItems(value: unknown): LineItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINE_ITEMS) {
    refuse(`lineItems must be a list of 1 to ${MAX_LINE_ITEMS} items.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      refuse(`lineItems[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    for (const name of Object.keys(record)) {
      if (name !== "name" && name !== "rate" && name !== "quantity") {
        refuse(`lineItems[${index}] has an unknown field "${name}".`);
      }
    }
    const name = record["name"];
    const rate = record["rate"];
    const quantity = record["quantity"];
    if (typeof name !== "string" || name.trim() === "" || name.length > 200) {
      refuse(`lineItems[${index}].name must be a non-empty string of at most 200 characters.`);
    }
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      refuse(`lineItems[${index}].rate must be a finite number, zero or more.`);
    }
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
      refuse(`lineItems[${index}].quantity must be a finite number above zero.`);
    }
    return { name: name.trim(), rate, quantity };
  });
}

interface InvoiceSummary {
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly status: string | null;
  readonly customerId: string | null;
  readonly referenceNumber: string | null;
  readonly total: number | null;
  readonly currencyCode: string | null;
}

function summarize(answer: unknown): InvoiceSummary {
  if (typeof answer !== "object" || answer === null) {
    throw new ConnectorError("upstream_error", "Zoho returned a response that is not an invoice.");
  }
  const body = answer as Record<string, unknown>;
  const invoice = body["invoice"];
  if (typeof invoice !== "object" || invoice === null) {
    throw new ConnectorError("upstream_error", "Zoho returned a response without an invoice.");
  }
  const record = invoice as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const id = record["invoice_id"];
  if (typeof id !== "string") {
    throw new ConnectorError("upstream_error", "Zoho returned an invoice without an id.");
  }
  return {
    invoiceId: id,
    invoiceNumber: text(record["invoice_number"]),
    status: text(record["status"]),
    customerId: text(record["customer_id"]),
    referenceNumber: text(record["reference_number"]),
    total: typeof record["total"] === "number" ? record["total"] : null,
    currencyCode: text(record["currency_code"]),
  };
}

export function createZohoConnector(options: ZohoConnectorOptions): GenericConnector {
  const organizationId = parseZohoOrganizationId(options.organizationId);
  const doFetch = options.fetch ?? fetch;

  async function call(path: string, method: "GET" | "POST", token: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<unknown> {
    const url = `${API}${path}${path.includes("?") ? "&" : "?"}organization_id=${encodeURIComponent(organizationId)}`;
    const writing = method === "POST";
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        signal,
        headers: {
          authorization: `Zoho-oauthtoken ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // For a create, the invoice may have been made before the failure.
      throw new ConnectorError("upstream_error", writing
        ? "The invoice may have been created in Zoho, and no answer was read. Check for an invoice with this reference number before any other action."
        : "Zoho did not answer the invoice request in time. Nothing was changed.");
    }
    const suffix = writing ? " Check for an invoice with this reference number before any other action." : "";
    if (!response.ok) {
      throw new ConnectorError("upstream_error", `Zoho returned HTTP ${response.status}.${suffix}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError("upstream_error", `Zoho returned a response that is not JSON.${suffix}`);
    }
    // Zoho can answer HTTP 200 with a non-zero application code.
    const code = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["code"] : undefined;
    if (typeof code === "number" && code !== 0) {
      throw new ConnectorError("upstream_error", `Zoho refused the request with code ${code}.${suffix}`);
    }
    return parsed;
  }

  return {
    system: "zoho",
    capabilities: [ZOHO_INVOICE_FETCH_CAPABILITY, ZOHO_INVOICE_CREATE_CAPABILITY],

    async execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse> {
      const allowed = request.capability === ZOHO_INVOICE_FETCH_CAPABILITY ? FETCH_PARAMETERS : request.capability === ZOHO_INVOICE_CREATE_CAPABILITY ? CREATE_PARAMETERS : null;
      if (allowed === null) {
        throw new ConnectorError("unknown_capability", `The Zoho connector does not run "${request.capability}".`);
      }
      for (const name of Object.keys(request.parameters)) {
        if (!allowed.has(name)) refuse(`Parameter "${name}" is not allowed for ${request.capability}.`);
      }

      const token = parseZohoAccessToken(context.credential.value);
      const fingerprint = zohoTokenFingerprint(token);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_BUDGET_MS);

      try {
        if (request.capability === ZOHO_INVOICE_FETCH_CAPABILITY) {
          const invoiceId = requireInvoiceId(request.parameters, request.target);
          const answer = await call(`/invoices/${encodeURIComponent(invoiceId)}`, "GET", token, controller.signal);
          return {
            success: true,
            metadata: { status: 200, body: { invoice: summarize(answer), tokenFingerprint: fingerprint } },
          };
        }

        // Create. The Parmana transaction id is the receipt, so it must be present.
        const transactionId = request.businessTransactionId;
        if (transactionId === undefined || transactionId.trim() === "") {
          refuse("An invoice create needs a businessTransactionId, which is written to the invoice as its reference number.");
        }
        const customerId = requireCustomerId(request.parameters);
        const lineItems = requireLineItems(request.parameters["lineItems"]);

        const answer = await call("/invoices", "POST", token, controller.signal, {
          customer_id: customerId,
          reference_number: transactionId,
          line_items: lineItems.map((item) => ({ name: item.name, rate: item.rate, quantity: item.quantity })),
        });
        return {
          success: true,
          metadata: { status: 201, body: { invoice: summarize(answer), tokenFingerprint: fingerprint } },
        };
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("upstream_error", request.capability === ZOHO_INVOICE_CREATE_CAPABILITY
          ? "The Zoho connector failed unexpectedly. Check for an invoice with this reference number before any other action."
          : "The Zoho connector failed unexpectedly. Nothing was changed.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
