import { describe, expect, it } from "vitest";

import { MemoryNonceStore, NONCE_TABLE, PostgresNonceStore } from "../../src/service/nonce-store.js";

const LATER = new Date(Date.now() + 60_000).toISOString();

describe("MemoryNonceStore", () => {
  it("accepts a key once", async () => {
    const store = new MemoryNonceStore();
    expect(await store.checkAndRecord("k", LATER)).toBe(true);
    expect(await store.checkAndRecord("k", LATER)).toBe(false);
  });

  it("forgets a key after it expires", async () => {
    const store = new MemoryNonceStore();
    expect(await store.checkAndRecord("k", new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(await store.checkAndRecord("k", LATER)).toBe(true);
  });
});

describe("PostgresNonceStore", () => {
  it("reports a key as new only when the insert wrote a row", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string, _params?: unknown[]) => {
        queries.push(sql);
        if (sql.startsWith("INSERT")) {
          return { rowCount: queries.filter((q) => q.startsWith("INSERT")).length === 1 ? 1 : 0 };
        }
        return { rowCount: 0 };
      },
    };
    const store = new PostgresNonceStore(pool as never);
    expect(await store.checkAndRecord("k", LATER)).toBe(true);
    expect(await store.checkAndRecord("k", LATER)).toBe(false);
    expect(queries.every((q) => q.includes(NONCE_TABLE) || q.includes("DELETE") || q.includes("INSERT"))).toBe(true);
  });

  it("purges only rows that expired a margin ago", async () => {
    const seen: string[] = [];
    const pool = {
      query: async (sql: string) => {
        seen.push(sql);
        return { rowCount: 1 };
      },
    };
    await new PostgresNonceStore(pool as never).checkAndRecord("k", LATER);
    expect(seen[0]).toContain(`DELETE FROM ${NONCE_TABLE} WHERE expires_at < now() - interval '5 minutes'`);
  });
});
