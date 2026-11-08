import type { Pool } from "pg";

/**
 * Records what this endpoint did for each release, so a repeat gets the first answer and
 * the connector never runs twice (parmana-core ADR-0013, gap G-132).
 *
 * claim() is atomic: exactly one caller for a businessTransactionId gets `claimed: true`
 * and may run the connector. Every other caller gets the stored answer, or `claimed: false`
 * with no answer while the first run is still in progress. complete() stores the answer.
 *
 * A claim with no answer is never released. If the process stops after the connector ran
 * but before the answer was stored, the id stays unanswered and a repeat gets 409. Nothing
 * runs twice, and an operator resolves it.
 */
export interface ReleaseLedger {
  claim(
    businessTransactionId: string,
    expiresAt: string,
  ): Promise<{ claimed: true } | { claimed: false; answer?: Record<string, unknown> }>;
  complete(businessTransactionId: string, answer: Record<string, unknown>): Promise<void>;
}

export const RELEASE_LEDGER_TABLE = "parmana_connectors_release_ledger";
/**
 * Answered releases whose window has closed move here. A transaction id is never
 * removed from the ledger, so it can never run again. The archive keeps the id blocked
 * and the active table small.
 */
export const RELEASE_LEDGER_ARCHIVE_TABLE = "parmana_connectors_release_ledger_archive";

/** Creates the ledger and its archive. Safe to run on every start. */
export const CREATE_RELEASE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS ${RELEASE_LEDGER_TABLE} (
    business_transaction_id text PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    answer jsonb
  );
  CREATE TABLE IF NOT EXISTS ${RELEASE_LEDGER_ARCHIVE_TABLE} (
    business_transaction_id text PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    answer jsonb NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now()
  )`;

/**
 * How long after a release's expiry its row may be archived. A release is refused after its
 * expiry plus 30 seconds of clock skew, so after this grace no release can still be replayed.
 */
export const ARCHIVE_GRACE_MS = 60_000;

/** One process only. Use the Postgres ledger when more than one instance runs. */
export class MemoryReleaseLedger implements ReleaseLedger {
  private readonly entries = new Map<string, Record<string, unknown> | null>();

  async claim(businessTransactionId: string): Promise<{ claimed: true } | { claimed: false; answer?: Record<string, unknown> }> {
    if (this.entries.has(businessTransactionId)) {
      const answer = this.entries.get(businessTransactionId);
      return answer === null || answer === undefined ? { claimed: false } : { claimed: false, answer };
    }
    this.entries.set(businessTransactionId, null);
    return { claimed: true };
  }

  async complete(businessTransactionId: string, answer: Record<string, unknown>): Promise<void> {
    this.entries.set(businessTransactionId, answer);
  }
}

/** Shared by every instance. The primary key makes the claim atomic across them. */
export class PostgresReleaseLedger implements ReleaseLedger {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async claim(
    businessTransactionId: string,
    expiresAt: string,
  ): Promise<{ claimed: true } | { claimed: false; answer?: Record<string, unknown> }> {
    // An archived id is never claimed again: the insert does nothing when the archive holds it.
    const inserted = await this.pool.query(
      `INSERT INTO ${RELEASE_LEDGER_TABLE} (business_transaction_id, expires_at)
       SELECT $1::text, $2::timestamptz
       WHERE NOT EXISTS (SELECT 1 FROM ${RELEASE_LEDGER_ARCHIVE_TABLE} WHERE business_transaction_id = $1::text)
       ON CONFLICT (business_transaction_id) DO NOTHING`,
      [businessTransactionId, expiresAt],
    );
    if (inserted.rowCount === 1) return { claimed: true };

    const existing = await this.pool.query(
      `SELECT answer FROM ${RELEASE_LEDGER_TABLE} WHERE business_transaction_id = $1
       UNION ALL
       SELECT answer FROM ${RELEASE_LEDGER_ARCHIVE_TABLE} WHERE business_transaction_id = $1
       LIMIT 1`,
      [businessTransactionId],
    );
    const answer = existing.rows[0]?.answer as Record<string, unknown> | null | undefined;
    return answer === null || answer === undefined ? { claimed: false } : { claimed: false, answer };
  }

  async complete(businessTransactionId: string, answer: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE ${RELEASE_LEDGER_TABLE} SET answer = $2 WHERE business_transaction_id = $1`,
      [businessTransactionId, JSON.stringify(answer)],
    );
  }
}

/**
 * Moves answered releases whose window closed more than ARCHIVE_GRACE_MS ago to the archive,
 * in one statement, so a row is never in neither table. Unanswered rows never move: their
 * outcome is unknown and an operator resolves them. Returns the number moved.
 */
export async function archiveFinishedReleases(pool: Pick<Pool, "query">, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ARCHIVE_GRACE_MS).toISOString();
  const moved = await pool.query(
    `WITH moved AS (
       DELETE FROM ${RELEASE_LEDGER_TABLE}
       WHERE expires_at < $1::timestamptz AND answer IS NOT NULL
       RETURNING business_transaction_id, expires_at, answer
     )
     INSERT INTO ${RELEASE_LEDGER_ARCHIVE_TABLE} (business_transaction_id, expires_at, answer)
     SELECT business_transaction_id, expires_at, answer FROM moved
     ON CONFLICT (business_transaction_id) DO NOTHING`,
    [cutoff],
  );
  return moved.rowCount ?? 0;
}
