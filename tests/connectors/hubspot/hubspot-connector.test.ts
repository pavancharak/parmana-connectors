import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext, type ConnectorRequest } from "../../../src/connector-contract.js";
import { HUBSPOT_DEAL_FETCH_CAPABILITY, HUBSPOT_DEAL_UPDATE_CAPABILITY, createHubSpotConnector, hubspotTokenFingerprint, parseHubSpotPrivateAppToken } from "../../../src/connectors/hubspot/hubspot-connector.js";

const TOKEN = "fake-hubspot-private-app-token-for-tests";
const DEAL = "12345678";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

/** A fake HubSpot deal. `deal` is what it returns, `status` the HTTP status, `fail` makes the call throw. */
function fakeHubSpot(options: { deal?: unknown; status?: number; fail?: boolean; rawText?: string } = {}) {
  const sent: Sent[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ method: String(init?.method), path: url.pathname, authorization: headers["authorization"], body });
    if (options.fail) throw new Error("socket reset");
    const text = options.rawText ?? JSON.stringify(options.deal ?? { id: DEAL, properties: { dealstage: "closedwon", amount: "5000", pipeline: "default" } });
    return new Response(text, { status: options.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: doFetch, sent };
}

function request(capability: string, parameters: Record<string, unknown> = {}, target: string | undefined = DEAL): ConnectorRequest {
  return { capability, parameters: { dealId: DEAL, ...parameters }, target, businessTransactionId: "3b8f4c1e-2a7d-4e9b-9c6f-1d2e3f4a5b6c" };
}

function context(value: string = TOKEN): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "HUBSPOT_PRIVATE_APP_TOKEN", value }, timeoutMs: 5_000 };
}

describe("hubspot connector: credential", () => {
  it("accepts a Private App token", () => {
    expect(parseHubSpotPrivateAppToken(TOKEN)).toBe(TOKEN);
  });

  it("refuses an empty token or one with spaces, without showing it", () => {
    expect(() => parseHubSpotPrivateAppToken("")).toThrow(ConnectorError);
    try {
      parseHubSpotPrivateAppToken("bad token value");
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).code).toBe("credential_invalid");
      expect((error as ConnectorError).message).not.toContain("bad token");
    }
  });

  it("gives a fingerprint that is not a piece of the token", () => {
    expect(hubspotTokenFingerprint(TOKEN)).toMatch(/^fp_[0-9a-f]{12}$/);
    expect(TOKEN).not.toContain(hubspotTokenFingerprint(TOKEN));
  });
});

describe("hubspot connector: refusals before any call", () => {
  it("refuses another capability", async () => {
    const fake = fakeHubSpot();
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request("hubspot:deal-delete"), context())).rejects.toMatchObject({ code: "unknown_capability" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a deal id that is not digits", async () => {
    const fake = fakeHubSpot();
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_FETCH_CAPABILITY, { dealId: "../12" }, undefined), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a deal id that is not the authorised target", async () => {
    const fake = fakeHubSpot();
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY, { dealstage: "closedlost" }, "99999999"), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a property other than dealstage or amount", async () => {
    const fake = fakeHubSpot();
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY, { dealstage: "closedwon", closedate: "2026-01-01" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses an update with neither dealstage nor amount", async () => {
    const fake = fakeHubSpot();
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a fetch that names dealstage", async () => {
    const fake = fakeHubSpot();
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_FETCH_CAPABILITY, { dealstage: "closedwon" }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a non-finite amount", async () => {
    const fake = fakeHubSpot();
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY, { amount: Number.NaN }), context())).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.sent).toHaveLength(0);
  });
});

describe("hubspot connector: fetching a deal", () => {
  it("reads the deal's dealstage, amount and pipeline", async () => {
    const fake = fakeHubSpot();
    const response = await createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_FETCH_CAPABILITY), context());

    expect(response.metadata.body).toEqual({
      deal: { id: DEAL, dealstage: "closedwon", amount: "5000", pipeline: "default" },
      tokenFingerprint: hubspotTokenFingerprint(TOKEN),
    });
    expect(fake.sent[0]?.method).toBe("GET");
    expect(fake.sent[0]?.path).toBe(`/crm/v3/objects/deals/${DEAL}`);
    expect(fake.sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a response that is not a deal", async () => {
    const fake = fakeHubSpot({ deal: { message: "not found" } });
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_FETCH_CAPABILITY), context())).rejects.toMatchObject({ code: "upstream_error" });
  });
});

describe("hubspot connector: updating a deal", () => {
  it("sends only dealstage and amount, as strings, in one PATCH", async () => {
    const fake = fakeHubSpot({ deal: { id: DEAL, properties: { dealstage: "closedlost", amount: "7500" } } });
    const response = await createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY, { dealstage: "closedlost", amount: 7500 }), context());

    expect(response.metadata.body).toMatchObject({ deal: { dealstage: "closedlost", amount: "7500" } });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.method).toBe("PATCH");
    expect(fake.sent[0]?.body).toEqual({ properties: { dealstage: "closedlost", amount: "7500" } });
  });

  it("can update dealstage alone", async () => {
    const fake = fakeHubSpot();
    await createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY, { dealstage: "closedwon" }), context());
    expect(fake.sent[0]?.body).toEqual({ properties: { dealstage: "closedwon" } });
  });

  it("tells the operator to check the deal when the update may have reached HubSpot", async () => {
    const fake = fakeHubSpot({ fail: true });
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY, { dealstage: "closedwon" }), context())).rejects.toThrow(/Check the deal/);
  });

  it("reports an HTTP error on the update as an error that says to check the deal", async () => {
    const fake = fakeHubSpot({ status: 500 });
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_UPDATE_CAPABILITY, { dealstage: "closedwon" }), context())).rejects.toThrow(/Check the deal/);
  });

  it("refuses a body that is not JSON", async () => {
    const fake = fakeHubSpot({ rawText: "<html>oops</html>" });
    await expect(createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_FETCH_CAPABILITY), context())).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("never shows the token in an error", async () => {
    const fake = fakeHubSpot({ status: 401 });
    try {
      await createHubSpotConnector({ fetch: fake.fetch }).execute(request(HUBSPOT_DEAL_FETCH_CAPABILITY), context());
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(TOKEN);
    }
  });
});
