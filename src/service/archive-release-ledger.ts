import { Pool } from "pg";

import { archiveFinishedReleases } from "./release-ledger.js";

/**
 * Moves finished releases to the archive. Run it on a schedule against the
 * database the service uses, for example once an hour:
 *
 *   npm run ledger:archive
 *
 * It needs PARMANA_DATABASE_URL. It prints how many rows it moved and exits.
 */
async function main(): Promise<void> {
  const url = process.env.PARMANA_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("PARMANA_DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const moved = await archiveFinishedReleases(pool);
    console.log(JSON.stringify({ event: "release_ledger_archived", moved }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
