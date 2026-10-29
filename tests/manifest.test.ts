import { describe, expect, it } from "vitest";

import { ConnectorError, type ConnectorExecutionContext } from "../src/connector-contract.js";
import { createGenericConnector } from "../src/connector.js";
import { loadManifest, validateManifest } from "../src/manifest.js";

const SECRET = "secret-value-123";

const HEADER_MANIFEST = `
system: example
baseUrl: https://api.example.test/v1
apiVersion: "2026-01"
credential:
  type: header
  headerName: X-Api-Key
  secretRef: EXAMPLE_API_KEY
capabilities:
  - id: example:get-thing
    method: GET
    path: /things/{id}
    effect: read
    input:
      id: { type: string, required: true }
      expand: { type: boolean }
  - id: example:create-thing
    method: POST
    path: /things
    effect: write
    input:
      name: { type: string, required: true }
      size: { type: integer }
`;

const BEARER_MANIFEST = `
system: example
baseUrl: https://api.example.test/v1
apiVersion: "2026-01"
credential:
  type: bearer
  secretRef: EXAMPLE_TOKEN
capabilities:
  - id: example:list-things
    method: GET
    path: /things
    effect: read
`;

function context(value = SECRET, timeoutMs = 5_000): ConnectorExecutionContext {
  return { credential: { providerId: "test", credentialId: "EXAMPLE_API_KEY", value }, timeoutMs };
}

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/** A fake upstream that records each request and answers with the given response. */
function fakeUpstream(respond: () => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: (init?.body as string | null) ?? null });
    return respond();
  }) as typeof fetch;
  return { seen, fetch: fetchImpl };
}

function headerConnector(fetch: typeof globalThis.fetch, extra: { maxResponseBytes?: number } = {}) {
  return createGenericConnector(loadOk(HEADER_MANIFEST), { fetch, ...extra });
}

function loadOk(text: string) {
  const result = loadManifest(text);
  if (!result.ok) throw new Error(`fixture is invalid: ${JSON.stringify(result.errors)}`);
  return result.manifest;
}

function errorOf(promise: Promise<unknown>): Promise<ConnectorError> {
  return promise.then(
    () => {
      throw new Error("expected a ConnectorError, but the call succeeded");
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(ConnectorError);
      return err as ConnectorError;
    },
  );
}

describe("manifest loading and validation", () => {
  it("loads a valid YAML manifest and lists its capabilities", () => {
    const result = loadManifest(HEADER_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.capabilities.map((cap) => cap.id)).toEqual(["example:get-thing", "example:create-thing"]);
  });

  it("refuses an http base URL unless the caller allows it", () => {
    const text = HEADER_MANIFEST.replace("https://", "http://");
    const refused = loadManifest(text);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors).toContainEqual({ path: "/baseUrl", message: "must use https://" });

    expect(loadManifest(text, { allowInsecureBaseUrl: true }).ok).toBe(true);
  });

  it("refuses a base URL that carries a query, a fragment, or credentials", () => {
    for (const base of ["https://user:pw@api.example.test/v1", "https://api.example.test/v1?x=1", "https://api.example.test/v1#f"]) {
      const result = validateManifest({ ...loadOk(HEADER_MANIFEST), baseUrl: base });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a GET capability declared as a write", () => {
    const text = HEADER_MANIFEST.replace("method: GET\n    path: /things/{id}\n    effect: read", "method: GET\n    path: /things/{id}\n    effect: write");
    const result = loadManifest(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.message)).toContain("a GET capability cannot be a write");
  });

  it("refuses a capability id that does not start with the system name, and a duplicate id", () => {
    const wrongPrefix = loadManifest(HEADER_MANIFEST.replace("id: example:create-thing", "id: other:create-thing"));
    expect(wrongPrefix.ok).toBe(false);

    const duplicate = loadManifest(HEADER_MANIFEST.replace("id: example:create-thing", "id: example:get-thing"));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errors.some((e) => e.message.includes("duplicate capability id"))).toBe(true);
  });

  it("refuses a path parameter that has no declared input, or that is not required", () => {
    const undeclared = loadManifest(HEADER_MANIFEST.replace("      id: { type: string, required: true }\n", ""));
    expect(undeclared.ok).toBe(false);

    const optional = loadManifest(HEADER_MANIFEST.replace("id: { type: string, required: true }", "id: { type: string }"));
    expect(optional.ok).toBe(false);
  });

  it("refuses a write capability with no declared input", () => {
    const text = HEADER_MANIFEST.replace("      name: { type: string, required: true }\n      size: { type: integer }\n", "");
    const result = loadManifest(text);
    expect(result.ok).toBe(false);
  });

  it("refuses a header credential without a header name", () => {
    const result = loadManifest(HEADER_MANIFEST.replace("  headerName: X-Api-Key\n", ""));
    expect(result.ok).toBe(false);
  });

  it("refuses YAML aliases", () => {
    const text = HEADER_MANIFEST.replace("apiVersion: \"2026-01\"", "apiVersion: &v \"2026-01\"\nnote: *v");
    const result = loadManifest(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain("cannot parse");
  });

  it("createGenericConnector throws invalid_input for an invalid manifest, before any network call", () => {
    const upstream = fakeUpstream();
    expect(() => createGenericConnector({ system: "example" }, { fetch: upstream.fetch })).toThrow(ConnectorError);
    expect(upstream.seen).toHaveLength(0);
  });
});

describe("the generic connector", () => {
  it("describes the system and its capabilities", () => {
    const connector = headerConnector(fakeUpstream().fetch);
    expect(connector.system).toBe("example");
    expect(connector.capabilities).toEqual(["example:get-thing", "example:create-thing"]);
  });

  it("fills path parameters, sends other read inputs in the query, and sends the credential in its header", async () => {
    const upstream = fakeUpstream();
    await headerConnector(upstream.fetch).execute(
      { capability: "example:get-thing", parameters: { id: "abc d", expand: true } },
      context(),
    );

    const [call] = upstream.seen;
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe("https://api.example.test/v1/things/abc%20d?expand=true");
    expect(call?.headers.get("x-api-key")).toBe(SECRET);
    expect(call?.body).toBeNull();
  });

  it("sends write inputs as a JSON body", async () => {
    const upstream = fakeUpstream();
    await headerConnector(upstream.fetch).execute({ capability: "example:create-thing", parameters: { name: "widget", size: 3 } }, context());

    const [call] = upstream.seen;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.example.test/v1/things");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call?.body ?? "null")).toEqual({ name: "widget", size: 3 });
  });

  it("sends a bearer credential as an Authorization header", async () => {
    const upstream = fakeUpstream();
    const connector = createGenericConnector(loadOk(BEARER_MANIFEST), { fetch: upstream.fetch });
    await connector.execute({ capability: "example:list-things", parameters: {} }, context());

    expect(upstream.seen[0]?.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("refuses an input that the manifest does not declare, before any request is made", async () => {
    const upstream = fakeUpstream();
    const error = await errorOf(headerConnector(upstream.fetch).execute({ capability: "example:get-thing", parameters: { id: "x", other: 1 } }, context()));

    expect(error.code).toBe("invalid_input");
    expect(upstream.seen).toHaveLength(0);
  });

  it("refuses a missing required input, and an input of the wrong type, before any request is made", async () => {
    const upstream = fakeUpstream();
    const connector = headerConnector(upstream.fetch);

    expect((await errorOf(connector.execute({ capability: "example:create-thing", parameters: {} }, context()))).code).toBe("invalid_input");
    expect((await errorOf(connector.execute({ capability: "example:create-thing", parameters: { name: "w", size: 1.5 } }, context()))).code).toBe("invalid_input");
    expect(upstream.seen).toHaveLength(0);
  });

  it("refuses a capability the manifest does not declare", async () => {
    const error = await errorOf(headerConnector(fakeUpstream().fetch).execute({ capability: "example:delete-all", parameters: {} }, context()));
    expect(error.code).toBe("unknown_capability");
  });

  it("refuses an empty credential, and names the reference rather than a value", async () => {
    const upstream = fakeUpstream();
    const error = await errorOf(headerConnector(upstream.fetch).execute({ capability: "example:create-thing", parameters: { name: "w" } }, context("")));

    expect(error.code).toBe("credential_invalid");
    expect(error.message).toContain("EXAMPLE_API_KEY");
    expect(upstream.seen).toHaveLength(0);
  });

  it("reports a non-2xx answer by status only, without the body", async () => {
    const upstream = fakeUpstream(() => new Response("upstream says the secret is wrong", { status: 500 }));
    const error = await errorOf(headerConnector(upstream.fetch).execute({ capability: "example:create-thing", parameters: { name: "w" } }, context()));

    expect(error.code).toBe("upstream_error");
    expect(error.message).toContain("returned status 500");
    expect(error.message).not.toContain("upstream says");
  });

  it("refuses a redirect, which fetch reports as a network error", async () => {
    const failing = (async () => {
      throw new TypeError("redirect");
    }) as typeof fetch;
    const error = await errorOf(headerConnector(failing).execute({ capability: "example:create-thing", parameters: { name: "w" } }, context()));

    expect(error.code).toBe("upstream_error");
    expect(error.message).toContain("redirects are refused");
  });

  it("stops a call that runs past the time limit the service gives", async () => {
    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      })) as typeof fetch;
    const error = await errorOf(headerConnector(hang).execute({ capability: "example:create-thing", parameters: { name: "w" } }, context(SECRET, 100)));

    expect(error.code).toBe("timeout");
    expect(error.message).toContain("100 ms");
  });

  it("parses a JSON answer, and returns a text answer as text", async () => {
    const json = await headerConnector(fakeUpstream(() => Response.json({ id: 1 })).fetch).execute(
      { capability: "example:create-thing", parameters: { name: "w" } },
      context(),
    );
    expect(json.metadata.body).toEqual({ id: 1 });

    const text = await headerConnector(fakeUpstream(() => new Response("plain", { headers: { "Content-Type": "text/plain" } })).fetch).execute(
      { capability: "example:create-thing", parameters: { name: "w" } },
      context(),
    );
    expect(text.metadata.body).toBe("plain");
  });

  it("refuses a JSON answer that does not parse", async () => {
    const upstream = fakeUpstream(() => new Response("{not json", { headers: { "Content-Type": "application/json" } }));
    const error = await errorOf(headerConnector(upstream.fetch).execute({ capability: "example:create-thing", parameters: { name: "w" } }, context()));

    expect(error.code).toBe("upstream_error");
    expect(error.message).toContain("did not parse");
  });

  it("refuses an answer larger than the limit", async () => {
    const upstream = fakeUpstream(() => new Response("x".repeat(50), { headers: { "Content-Type": "text/plain" } }));
    const error = await errorOf(
      headerConnector(upstream.fetch, { maxResponseBytes: 10 }).execute({ capability: "example:create-thing", parameters: { name: "w" } }, context()),
    );

    expect(error.code).toBe("upstream_error");
    expect(error.message).toContain("larger than 10 bytes");
  });
});
