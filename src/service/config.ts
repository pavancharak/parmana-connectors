import { createPublicKey, type KeyObject } from "node:crypto";

import { ConnectorError } from "../connector-contract.js";

import { assertCredentialUsable, credentialVariableFor, isConnectorName, CONNECTOR_NAMES, type ConnectorName } from "./registry.js";

/**
 * Settings for the service, read from the environment. Every value is required
 * unless it says otherwise. A missing or invalid value stops startup with a
 * message that names the setting, never its value.
 */
export interface ServiceConfig {
  readonly port: number;
  /** Address to bind. 127.0.0.1 unless PARMANA_SERVICE_HOST says otherwise. */
  readonly host: string;
  /** Parmana's Ed25519 public key. Releases are refused unless they verify against it. */
  readonly publicKey: KeyObject;
  /** This endpoint's URL, exactly as registered in parmana-core. Must be https. */
  readonly audience: string;
  readonly connector: ConnectorName;
  /** Name of the environment variable that holds the connector's credential. */
  readonly credentialVariable: string;
  /** Live keys are accepted only when this is true. Default false. */
  readonly allowLiveKeys: boolean;
  readonly timeoutMs: number;
  /** postgres: shared by every instance. memory: one process only, for tests. */
  readonly nonceStore: "postgres" | "memory";
  /** Set when nonceStore is postgres. */
  readonly databaseUrl?: string | undefined;
}

export interface ConfigReaders {
  readonly readFile: (path: string) => string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadServiceConfig(env: Readonly<Record<string, string | undefined>>, readers: ConfigReaders): ServiceConfig {
  const connector = parseConnector(required(env, "PARMANA_CONNECTOR"));
  const credentialVariable = credentialVariableFor(connector);
  const allowLiveKeys = parseBoolean(env.PARMANA_ALLOW_LIVE_KEYS, "PARMANA_ALLOW_LIVE_KEYS");

  const credential = required(env, credentialVariable);
  try {
    assertCredentialUsable(connector, credential, allowLiveKeys);
  } catch (err) {
    const reason = err instanceof ConnectorError ? err.message : "it could not be checked";
    throw new ConfigError(`${credentialVariable} cannot be used: ${reason}`);
  }

  const publicKey = loadPublicKey(env, readers);

  const audience = requiredHttpsUrl(env, "PARMANA_RELEASE_AUDIENCE");

  const port = parseInteger(env.PARMANA_SERVICE_PORT ?? "8080", "PARMANA_SERVICE_PORT", 1, 65535);
  const host = env.PARMANA_SERVICE_HOST ?? "127.0.0.1";
  const timeoutMs = parseInteger(env.PARMANA_CONNECTOR_TIMEOUT_MS ?? "10000", "PARMANA_CONNECTOR_TIMEOUT_MS", 100, 120_000);

  const nonceStore = parseNonceStore(env.PARMANA_NONCE_STORE);
  const databaseUrl = nonceStore === "postgres" ? required(env, "PARMANA_DATABASE_URL") : undefined;

  return {
    port,
    host,
    publicKey,
    audience,
    connector,
    credentialVariable,
    allowLiveKeys,
    timeoutMs,
    nonceStore,
    databaseUrl,
  };
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function parseConnector(raw: string): ConnectorName {
  if (isConnectorName(raw)) return raw;
  throw new ConfigError(`PARMANA_CONNECTOR must be one of: ${CONNECTOR_NAMES.join(", ")}`);
}

function parseBoolean(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new ConfigError(`${name} must be true or false`);
}

/**
 * The key comes from PARMANA_PUBLIC_KEY (the PEM text) or PARMANA_PUBLIC_KEY_FILE (a path to it), never both.
 * Pasted PEM often arrives with literal \n sequences, so those are turned into line breaks.
 */
function loadPublicKey(env: Readonly<Record<string, string | undefined>>, readers: ConfigReaders): KeyObject {
  const pem = env.PARMANA_PUBLIC_KEY;
  const path = env.PARMANA_PUBLIC_KEY_FILE;
  const hasPem = pem !== undefined && pem.trim() !== "";
  const hasPath = path !== undefined && path.trim() !== "";

  if (hasPem && hasPath) {
    throw new ConfigError("set either PARMANA_PUBLIC_KEY or PARMANA_PUBLIC_KEY_FILE, not both");
  }
  if (hasPem) {
    return parsePublicKey(pem.replace(/\\n/g, "\n"), "PARMANA_PUBLIC_KEY");
  }
  if (hasPath) {
    return parsePublicKey(readers.readFile(path), "PARMANA_PUBLIC_KEY_FILE");
  }
  throw new ConfigError("PARMANA_PUBLIC_KEY or PARMANA_PUBLIC_KEY_FILE is required");
}

function parsePublicKey(pem: string, name: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new ConfigError(`${name} is not a valid PEM public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ConfigError(`${name} must be an Ed25519 public key`);
  }
  return key;
}

/** Defaults to postgres. The memory store must be asked for by name, because it does not share replay protection. */
function parseNonceStore(raw: string | undefined): "postgres" | "memory" {
  if (raw === undefined || raw === "postgres") return "postgres";
  if (raw === "memory") return "memory";
  throw new ConfigError("PARMANA_NONCE_STORE must be postgres or memory");
}

function parseInteger(raw: string, name: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function requiredHttpsUrl(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute https URL`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(`${name} must use https://`);
  }
  return value;
}
