import type { Pool } from "pg";

/**
 * Records a single-use key. Returns true only the first time the key is seen
 * before it expires. Implementations must make this atomic across every
 * instance that shares them.
 */
export interface NonceStore {
  checkAndRecord(key: string, expiresAt: string): Promise<boolean>;
}

/** Keeps keys in one process. A restart forgets them, so use it for tests and one instance only. */
export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  async checkAndRecord(key: string, expiresAt: string): Promise<boolean> {
    const now = Date.now();
    for (const [seenKey, until] of this.seen) {
      if (until < now) this.seen.delete(seenKey);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.parse(expiresAt));
    return true;
  }
}

export const NONCE_TABLE = "parmana_connectors_nonces";

/** Creates the table that holds the keys. Safe to run on every start. */
export const CREATE_NONCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${NONCE_TABLE} (
    nonce text PRIMARY KEY,
    expires_at timestamptz NOT NULL
  )`;

/**
 * Rows are removed only this long after they expire. The margin covers clock
 * differences between the service and the database.
 */
const PURGE_MARGIN = "5 minutes";

/**
 * Shared by every instance of the service. The primary key makes the insert
 * atomic: when two instances race on one key, exactly one insert succeeds.
 * The service records a key before it runs the connector, so a second release
 * for the same transaction is refused even if it arrives on another instance.
 */
export class PostgresNonceStore implements NonceStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async checkAndRecord(key: string, expiresAt: string): Promise<boolean> {
    await this.pool.query(`DELETE FROM ${NONCE_TABLE} WHERE expires_at < now() - interval '${PURGE_MARGIN}'`);
    const result = await this.pool.query(
      `INSERT INTO ${NONCE_TABLE} (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING`,
      [key, expiresAt],
    );
    return result.rowCount === 1;
  }
}
