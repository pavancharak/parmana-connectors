import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CREATE_NONCE_TABLE_SQL, PostgresNonceStore } from "../../src/service/nonce-store.js";

/**
 * Runs against a real PostgreSQL when PARMANA_TEST_DATABASE_URL is set. It is
 * skipped otherwise, so the suite still runs without a database.
 */
const url = process.env.PARMANA_TEST_DATABASE_URL;
const LATER = new Date(Date.now() + 60_000).toISOString();

describe.skipIf(url === undefined)("PostgresNonceStore against a real database", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 20 });
    await pool.query(CREATE_NONCE_TABLE_SQL);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("accepts a key once, across separate store instances on one database", async () => {
    const key = `release:${randomUUID()}`;
    const first = new PostgresNonceStore(pool);
    const second = new PostgresNonceStore(pool);
    expect(await first.checkAndRecord(key, LATER)).toBe(true);
    expect(await second.checkAndRecord(key, LATER)).toBe(false);
  });

  it("lets exactly one of many simultaneous attempts through", async () => {
    const key = `release:${randomUUID()}`;
    const stores = Array.from({ length: 20 }, () => new PostgresNonceStore(pool));
    const results = await Promise.all(stores.map((store) => store.checkAndRecord(key, LATER)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("removes rows that expired well before now, and keeps live ones", async () => {
    const old = `release:${randomUUID()}`;
    const live = `release:${randomUUID()}`;
    await pool.query("INSERT INTO parmana_connectors_nonces (nonce, expires_at) VALUES ($1, now() - interval '1 hour')", [old]);
    await new PostgresNonceStore(pool).checkAndRecord(live, LATER);
    const rows = await pool.query("SELECT nonce FROM parmana_connectors_nonces WHERE nonce IN ($1, $2)", [old, live]);
    expect(rows.rows.map((row) => row.nonce)).toEqual([live]);
  });
});
