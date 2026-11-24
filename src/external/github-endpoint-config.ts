import { createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The GitHub external endpoint's configuration, with the same variable names and
 * rules as the Razorpay service in this repository:
 *
 *   PARMANA_PUBLIC_KEY       Parmana's public key, as PEM text. Literal "\n" sequences are turned into line breaks.
 *   PARMANA_PUBLIC_KEY_FILE  A path to the same PEM. Set one of the two, never both.
 *   PARMANA_RELEASE_AUDIENCE This endpoint's URL, exactly as registered in Parmana. Must be https.
 *   GITHUB_APP_CREDENTIAL    "<app id>:<installation id>:<base64 of the App's PEM key>".
 *   PORT                     Optional. Defaults to 8080.
 */
export interface GitHubEndpointConfig {
  readonly publicKey: KeyObject;
  readonly audience: string;
  readonly credential: string;
  readonly port: number;
}

export class GitHubEndpointConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubEndpointConfigError";
  }
}

export function loadGitHubEndpointConfig(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): GitHubEndpointConfig {
  const pem = env["PARMANA_PUBLIC_KEY"];
  const path = env["PARMANA_PUBLIC_KEY_FILE"];
  const hasPem = pem !== undefined && pem.trim() !== "";
  const hasPath = path !== undefined && path.trim() !== "";
  if (hasPem && hasPath) {
    throw new GitHubEndpointConfigError("set either PARMANA_PUBLIC_KEY or PARMANA_PUBLIC_KEY_FILE, not both");
  }
  let keyText: string;
  let keyName: string;
  if (hasPem) {
    keyText = pem.replace(/\\n/g, "\n");
    keyName = "PARMANA_PUBLIC_KEY";
  } else if (hasPath) {
    keyText = readFile(path);
    keyName = "PARMANA_PUBLIC_KEY_FILE";
  } else {
    throw new GitHubEndpointConfigError("PARMANA_PUBLIC_KEY or PARMANA_PUBLIC_KEY_FILE is required");
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(keyText);
  } catch {
    throw new GitHubEndpointConfigError(`${keyName} is not a valid PEM public key`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new GitHubEndpointConfigError(`${keyName} must be an Ed25519 public key`);
  }

  const audience = required(env, "PARMANA_RELEASE_AUDIENCE");
  let url: URL;
  try {
    url = new URL(audience);
  } catch {
    throw new GitHubEndpointConfigError("PARMANA_RELEASE_AUDIENCE must be an absolute https URL");
  }
  if (url.protocol !== "https:") {
    throw new GitHubEndpointConfigError("PARMANA_RELEASE_AUDIENCE must be an absolute https URL");
  }

  const credential = required(env, "GITHUB_APP_CREDENTIAL");

  const portText = env["PORT"] ?? "8080";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GitHubEndpointConfigError("PORT must be an integer from 1 to 65535");
  }

  return { publicKey, audience, credential, port };
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new GitHubEndpointConfigError(`${name} is required`);
  }
  return value.trim();
}
