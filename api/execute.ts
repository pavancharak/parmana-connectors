import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Pool } from "pg";

import { loadServiceConfig } from "../src/service/config.js";
import { log } from "../src/service/log.js";
import { createConnector } from "../src/service/registry.js";
import {
  CREATE_RELEASE_LEDGER_SQL,
  MemoryReleaseLedger,
  PostgresReleaseLedger,
  type ReleaseLedger,
} from "../src/service/release-ledger.js";
import { conditionEvaluatorsFor } from "../src/service/condition-evaluator-registry.js";
import { createService } from "../src/service/server.js";

type Handle = ReturnType<typeof createService>["handle"];

/**
 * One service per warm function instance. Built on the first request so a bad
 * setting fails that request with a 500 instead of crashing the module.
 */
let ready: Promise<Handle> | undefined;

function init(): Promise<Handle> {
  ready ??= build().catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

async function build(): Promise<Handle> {
  const config = loadServiceConfig(process.env, {
    readFile: (path) => readFileSync(path, "utf8"),
  });

  let releaseLedger: ReleaseLedger;
  if (config.releaseLedger === "postgres") {
    const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
    await pool.query(CREATE_RELEASE_LEDGER_SQL);
    releaseLedger = new PostgresReleaseLedger(pool);
  } else {
    releaseLedger = new MemoryReleaseLedger();
  }

  const credentialVariable = config.credentialVariable;
  const service = createService({
    publicKey: config.publicKey,
    audience: config.audience,
    releaseLedger,
    connector: createConnector(config.connector, { allowLiveKeys: config.allowLiveKeys }),
    credentialId: credentialVariable,
    resolveCredential: () => {
      const value = process.env[credentialVariable];
      if (value === undefined || value === "") {
        throw new Error(`${credentialVariable} is not set`);
      }
      return value;
    },
    timeoutMs: config.timeoutMs,
    conditionEvaluators: conditionEvaluatorsFor(config.connector, {
      credential: process.env[credentialVariable] ?? "",
      allowLiveKeys: config.allowLiveKeys,
    }),
  });
  return service.handle;
}

/**
 * Vercel routes this file at /api/execute and /api/health. The service routes on
 * /execute and /health, so the /api prefix is removed before the request is handled.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  req.url = req.url?.replace(/^\/api(?=\/|$)/, "");
  let handle: Handle;
  try {
    handle = await init();
  } catch (err) {
    log("service_not_configured", { reason: err instanceof Error ? err.message : "unknown error" });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "service is not configured" }));
    return;
  }
  await handle(req, res);
}
