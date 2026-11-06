import { readFileSync } from "node:fs";

import { ConfigError, loadServiceConfig, type ServiceConfig } from "./config.js";

/**
 * Runs the same loader the Vercel function runs, and says whether it would start.
 * Reports only setting names and non-secret facts, never a value. The function
 * handler returns a generic 500 when the loader fails, so this is how to find the
 * setting that is wrong before a deploy.
 */
export type ConfigCheck =
  | { readonly ok: true; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

export function checkConfig(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ConfigCheck {
  try {
    const config = loadServiceConfig(env, {
      readFile: (path) => {
        try {
          return readFile(path);
        } catch {
          // The path is not echoed: it names a file, and the message should say which setting to fix.
          throw new ConfigError("the file named by PARMANA_PUBLIC_KEY_FILE could not be read");
        }
      },
    });
    return { ok: true, summary: summarize(config) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown configuration error" };
  }
}

function summarize(config: ServiceConfig): string {
  return [
    `connector: ${config.connector}`,
    `audience: ${config.audience}`,
    `live keys allowed: ${config.allowLiveKeys}`,
    `nonce store: ${config.nonceStore}`,
    `timeout: ${config.timeoutMs} ms`,
  ].join("\n");
}
