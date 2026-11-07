import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CREATE_RELEASE_LEDGER_SQL, PostgresReleaseLedger } from "../../src/service/release-ledger.js";

/**
 * The live release ledger (the production default) against a real PostgreSQL.
 * Runs when PARMANA_TEST_DATABASE_URL is set and is skipped otherwise.
 */
const url = process.env.PARMANA_TEST_DATABASE_URL;
const LATER = new Date(Date.now() + 60_000).toISOString();

describe.skipIf(url === undefined)("PostgresReleaseLedger against a real database", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 20 });
    await pool.query(CREATE_RELEASE_LEDGER_SQL);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("claims a transaction once, and refuses a repeat while the first run has no answer", async () => {
    const id = `btx_${randomUUID()}`;
    const ledger = new PostgresReleaseLedger(pool);
    expect(await ledger.claim(id, LATER)).toEqual({ claimed: true });
    expect(await ledger.claim(id, LATER)).toEqual({ claimed: false });
  });

  it("returns the stored answer to a repeat after complete, across separate ledger instances", async () => {
    const id = `btx_${randomUUID()}`;
    const answer = { success: true, status: "refunded", body: { id: "rfnd_1" } };
    expect(await new PostgresReleaseLedger(pool).claim(id, LATER)).toEqual({ claimed: true });
    await new PostgresReleaseLedger(pool).complete(id, answer);
    expect(await new PostgresReleaseLedger(pool).claim(id, LATER)).toEqual({ claimed: false, answer });
  });

  it("lets exactly one of many simultaneous claims through", async () => {
    const id = `btx_${randomUUID()}`;
    const ledgers = Array.from({ length: 20 }, () => new PostgresReleaseLedger(pool));
    const results = await Promise.all(ledgers.map((ledger) => ledger.claim(id, LATER)));
    expect(results.filter((result) => "claimed" in result && result.claimed)).toHaveLength(1);
  });
});
