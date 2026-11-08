import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archiveFinishedReleases,
  CREATE_RELEASE_LEDGER_SQL,
  PostgresReleaseLedger,
  RELEASE_LEDGER_TABLE,
} from "../../src/service/release-ledger.js";

/**
 * The live release ledger (the production default) against a real PostgreSQL.
 * Runs when PARMANA_TEST_DATABASE_URL is set and is skipped otherwise.
 */
const url = process.env.PARMANA_TEST_DATABASE_URL;
const LATER = new Date(Date.now() + 60_000).toISOString();
const CLOSED = new Date(Date.now() - 10 * 60_000).toISOString();

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

  it("archives an answered release once its window has closed, and never runs its id again", async () => {
    const id = `btx_${randomUUID()}`;
    const answer = { success: true, status: "refunded" };
    const ledger = new PostgresReleaseLedger(pool);
    expect(await ledger.claim(id, CLOSED)).toEqual({ claimed: true });
    await ledger.complete(id, answer);

    expect(await archiveFinishedReleases(pool)).toBeGreaterThanOrEqual(1);
    const active = await pool.query(`SELECT 1 FROM ${RELEASE_LEDGER_TABLE} WHERE business_transaction_id = $1`, [id]);
    expect(active.rowCount).toBe(0);

    expect(await new PostgresReleaseLedger(pool).claim(id, LATER)).toEqual({ claimed: false, answer });
    const reinserted = await pool.query(`SELECT 1 FROM ${RELEASE_LEDGER_TABLE} WHERE business_transaction_id = $1`, [id]);
    expect(reinserted.rowCount).toBe(0);
  });

  it("never archives a release that has no answer, so an unknown outcome stays for an operator", async () => {
    const id = `btx_${randomUUID()}`;
    expect(await new PostgresReleaseLedger(pool).claim(id, CLOSED)).toEqual({ claimed: true });

    await archiveFinishedReleases(pool);
    const active = await pool.query(`SELECT 1 FROM ${RELEASE_LEDGER_TABLE} WHERE business_transaction_id = $1`, [id]);
    expect(active.rowCount).toBe(1);
    expect(await new PostgresReleaseLedger(pool).claim(id, LATER)).toEqual({ claimed: false });
  });
});
