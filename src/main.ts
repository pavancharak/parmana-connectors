import { readFileSync } from "node:fs";

import { Pool } from "pg";

import { ConfigError, loadServiceConfig } from "./service/config.js";
import { log } from "./service/log.js";
import { CREATE_NONCE_TABLE_SQL, MemoryNonceStore, PostgresNonceStore, type NonceStore } from "./service/nonce-store.js";
import { createConnector } from "./service/registry.js";
import { createService } from "./service/server.js";

/** How long in-flight requests may take to finish after a shutdown signal, in milliseconds. */
const SHUTDOWN_GRACE_MS = 25_000;

async function main(): Promise<void> {
  const config = loadServiceConfig(process.env, {
    readFile: (path) => readFileSync(path, "utf8"),
  });

  let pool: Pool | undefined;
  let nonceStore: NonceStore;
  if (config.nonceStore === "postgres") {
    pool = new Pool({ connectionString: config.databaseUrl });
    await pool.query(CREATE_NONCE_TABLE_SQL);
    nonceStore = new PostgresNonceStore(pool);
  } else {
    log("nonce_store_memory", { warning: "replay protection is per process" });
    nonceStore = new MemoryNonceStore();
  }

  const credentialVariable = config.credentialVariable;
  const service = createService({
    publicKey: config.publicKey,
    audience: config.audience,
    nonceStore,
    connector: createConnector(config.connector, { allowLiveKeys: config.allowLiveKeys }),
    credentialId: credentialVariable,
    resolveCredential: () => {
      const value = process.env[credentialVariable];
      if (value === undefined || value === "") {
        throw new ConfigError(`${credentialVariable} is not set`);
      }
      return value;
    },
    timeoutMs: config.timeoutMs,
  });

  const server = await service.listen(config.port, config.host);
  log("service_started", { connector: config.connector, host: config.host, port: config.port, nonceStore: config.nonceStore });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log("shutdown_started", { signal });
    const timer = setTimeout(() => {
      log("shutdown_forced");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close(() => {
      void (pool ? pool.end() : Promise.resolve()).then(() => {
        log("shutdown_complete");
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "unknown error";
  process.stderr.write(`service did not start: ${message}\n`);
  process.exit(1);
});
