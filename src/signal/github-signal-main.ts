import { createGitHubSignalHttpServer } from "./github-signal-service.js";

/**
 * Starts the GitHub signal service. Every setting is read from the environment, and a missing
 * one stops the service before it listens.
 *
 *   PARMANA_SIGNAL_AUDIENCE                 the https URL Parmana queries (required)
 *   PARMANA_SIGNAL_PARMANA_PUBLIC_KEY_PEM   Parmana's Ed25519 public key, PEM (required)
 *   PARMANA_SIGNAL_PARMANA_KEY_ID           Parmana's key id (default "default")
 *   PARMANA_SIGNAL_SIGNING_KEY_PEM          this service's Ed25519 private key, PEM (required)
 *   PARMANA_SIGNAL_SIGNING_KEY_ID           this service's key id (default "signal-1")
 *   GITHUB_APP_CREDENTIAL                   "<app id>:<installation id>:<base64 of the App's PEM key>" (required)
 *   GITHUB_SIGNAL_ALLOWED_REPOSITORIES      comma-separated "owner/repo" list (required)
 *   PORT                                    default 8080
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

const audience = required("PARMANA_SIGNAL_AUDIENCE");
if (!audience.startsWith("https://")) throw new Error("PARMANA_SIGNAL_AUDIENCE must be an https URL");

const allowedRepositories = new Set(
  required("GITHUB_SIGNAL_ALLOWED_REPOSITORIES")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(name)),
);
if (allowedRepositories.size === 0) throw new Error("GITHUB_SIGNAL_ALLOWED_REPOSITORIES names no valid repository");

const server = createGitHubSignalHttpServer({
  audience,
  parmanaPublicKeyPem: required("PARMANA_SIGNAL_PARMANA_PUBLIC_KEY_PEM"),
  parmanaKeyId: process.env["PARMANA_SIGNAL_PARMANA_KEY_ID"]?.trim() || "default",
  signingKeyPem: required("PARMANA_SIGNAL_SIGNING_KEY_PEM"),
  signingKeyId: process.env["PARMANA_SIGNAL_SIGNING_KEY_ID"]?.trim() || "signal-1",
  credential: required("GITHUB_APP_CREDENTIAL"),
  allowedRepositories,
});

const port = Number(process.env["PORT"] ?? 8080);
server.listen(port, () => {
  console.log(`github signal service listening on ${port} for ${audience}`);
});
