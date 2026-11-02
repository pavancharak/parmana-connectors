import { createHash } from "node:crypto";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest, type ConnectorResponse, type GenericConnector } from "../../connector-contract.js";

/**
 * A connector for HubSpot deals. It has the same shape as the generic
 * connector, so the execution service can run either one.
 *
 * Two capabilities:
 * - `hubspot:deal-fetch` reads a deal's dealstage, amount and pipeline.
 * - `hubspot:deal-update` sets a deal's dealstage and/or amount, and nothing else.
 *
 * Only `dealstage` and `amount` are ever sent to HubSpot. Any other parameter
 * is refused before a call. The deal id must equal the release target when the
 * release names one, so a caller cannot change one deal while the policy
 * approved another.
 *
 * Authentication is a HubSpot Private App token, read as the credential. It is
 * sent only as a bearer header. Errors and results show only a fingerprint of it.
 *
 * A repeated update sets the same final values, so it leaves the deal in the
 * same state. Nothing is incremented, so a repeat is not a second change.
 */

export const HUBSPOT_DEAL_FETCH_CAPABILITY = "hubspot:deal-fetch";
export const HUBSPOT_DEAL_UPDATE_CAPABILITY = "hubspot:deal-update";

const API = "https://api.hubapi.com";
const DEFAULT_BUDGET_MS = 10_000;
const FETCH_PARAMETERS: ReadonlySet<string> = new Set(["dealId"]);
const UPDATE_PARAMETERS: ReadonlySet<string> = new Set(["dealId", "dealstage", "amount"]);

export interface HubSpotConnectorOptions {
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

/** A fingerprint of the token, safe to show. Never a substring of it. */
export function hubspotTokenFingerprint(token: string): string {
  return `fp_${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12)}`;
}

/** Reads the Private App token. Refuses an empty value or one with whitespace, without showing it. */
export function parseHubSpotPrivateAppToken(value: string): string {
  const token = value.trim();
  if (token === "" || /\s/.test(token)) {
    throw new ConnectorError("credential_invalid", "The HubSpot Private App token is empty or contains spaces. Its value is not shown.");
  }
  return token;
}

function refuse(message: string): never {
  throw new ConnectorError("invalid_input", message);
}

function requireDealId(parameters: Readonly<Record<string, unknown>>, target: string | undefined): string {
  const dealId = parameters["dealId"];
  if (typeof dealId !== "string" || !/^\d{1,20}$/.test(dealId)) {
    refuse("dealId must be a HubSpot deal id (digits only).");
  }
  if (target !== undefined && target !== dealId) {
    refuse(`The deal "${dealId}" is not the authorised target.`);
  }
  return dealId;
}

interface DealSummary {
  readonly id: string;
  readonly dealstage: string | null;
  readonly amount: string | null;
  readonly pipeline: string | null;
}

function summarize(answer: unknown): DealSummary {
  if (typeof answer !== "object" || answer === null) {
    throw new ConnectorError("upstream_error", "HubSpot returned a response that is not a deal.");
  }
  const deal = answer as Record<string, unknown>;
  const properties = (typeof deal["properties"] === "object" && deal["properties"] !== null ? deal["properties"] : {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  if (typeof deal["id"] !== "string") {
    throw new ConnectorError("upstream_error", "HubSpot returned a deal without an id.");
  }
  return {
    id: deal["id"],
    dealstage: text(properties["dealstage"]),
    amount: text(properties["amount"]),
    pipeline: text(properties["pipeline"]),
  };
}

export function createHubSpotConnector(options: HubSpotConnectorOptions = {}): GenericConnector {
  const doFetch = options.fetch ?? fetch;

  async function call(path: string, method: "GET" | "PATCH", token: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${API}${path}`, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // For a PATCH, the change may have reached HubSpot before the failure.
      throw new ConnectorError("upstream_error", method === "PATCH"
        ? "The deal update may have reached HubSpot, and no answer was read. Check the deal before any other action."
        : "HubSpot did not answer the deal request in time. Nothing was changed.");
    }
    if (!response.ok) {
      throw new ConnectorError("upstream_error", `HubSpot returned HTTP ${response.status}.${method === "PATCH" ? " Check the deal before any other action." : ""}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError("upstream_error", `HubSpot returned a response that is not JSON.${method === "PATCH" ? " Check the deal before any other action." : ""}`);
    }
  }

  return {
    system: "hubspot",
    capabilities: [HUBSPOT_DEAL_FETCH_CAPABILITY, HUBSPOT_DEAL_UPDATE_CAPABILITY],

    async execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse> {
      const allowed = request.capability === HUBSPOT_DEAL_FETCH_CAPABILITY ? FETCH_PARAMETERS : request.capability === HUBSPOT_DEAL_UPDATE_CAPABILITY ? UPDATE_PARAMETERS : null;
      if (allowed === null) {
        throw new ConnectorError("unknown_capability", `The HubSpot connector does not run "${request.capability}".`);
      }
      for (const name of Object.keys(request.parameters)) {
        if (!allowed.has(name)) refuse(`Parameter "${name}" is not allowed for ${request.capability}.`);
      }

      const dealId = requireDealId(request.parameters, request.target);

      let properties: Record<string, string> | undefined;
      if (request.capability === HUBSPOT_DEAL_UPDATE_CAPABILITY) {
        const dealstage = request.parameters["dealstage"];
        const amount = request.parameters["amount"];
        if (dealstage === undefined && amount === undefined) {
          refuse("A deal update needs dealstage, amount, or both.");
        }
        properties = {};
        if (dealstage !== undefined) {
          if (typeof dealstage !== "string" || dealstage.trim() === "") refuse("dealstage must be a non-empty string.");
          properties["dealstage"] = dealstage.trim();
        }
        if (amount !== undefined) {
          if (typeof amount !== "number" || !Number.isFinite(amount)) refuse("amount must be a finite number.");
          properties["amount"] = String(amount);
        }
      }

      const token = parseHubSpotPrivateAppToken(context.credential.value);
      const fingerprint = hubspotTokenFingerprint(token);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), context.timeoutMs > 0 ? context.timeoutMs : DEFAULT_BUDGET_MS);

      try {
        if (properties === undefined) {
          const answer = await call(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealstage,amount,pipeline`, "GET", token, controller.signal);
          return {
            success: true,
            metadata: { status: 200, body: { deal: summarize(answer), tokenFingerprint: fingerprint } },
          };
        }

        const answer = await call(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, "PATCH", token, controller.signal, { properties });
        return {
          success: true,
          metadata: { status: 200, body: { deal: summarize(answer), tokenFingerprint: fingerprint } },
        };
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("upstream_error", "The HubSpot connector failed unexpectedly. Check the deal before any other action.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
