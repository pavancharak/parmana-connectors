/**
 * Runs the GitHub external endpoint as an HTTP server.
 *
 * Configuration is read by github-endpoint-config.ts. Required environment:
 *   PARMANA_PUBLIC_KEY or PARMANA_PUBLIC_KEY_FILE   Parmana's Ed25519 public key (set one, not both)
 *   PARMANA_RELEASE_AUDIENCE                        This endpoint's https URL, exactly as registered in Parmana
 *   GITHUB_APP_CREDENTIAL                           "<app id>:<installation id>:<base64 of the App's PEM key>"
 * Optional: PORT (default 8080).
 *
 * It accepts POST only, with a JSON body of at most 256 KiB, and answers with the
 * endpoint's status and JSON body. It logs only its start-up line.
 */
import { createServer } from "node:http";

import { verifyParmanaRelease } from "@parmana/sdk";

import { createGitHubReleaseEndpoint } from "../connectors/github/external-endpoint.js";

import { loadGitHubEndpointConfig } from "./github-endpoint-config.js";

const MAX_BODY_BYTES = 256 * 1024;

const config = loadGitHubEndpointConfig(process.env);

const handle = createGitHubReleaseEndpoint({
  verify: verifyParmanaRelease,
  publicKeys: { default: config.publicKey.export({ type: "spki", format: "pem" }).toString() },
  audience: config.audience,
  credential: config.credential,
});

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(JSON.stringify({ error: "POST only" }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (tooLarge) return;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ errors: ["the body is not JSON"] }));
      return;
    }
    handle(body)
      .then((answer) => {
        res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
      })
      .catch(() => {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "The endpoint failed. Nothing is recorded as done." }));
      });
  });
});

server.listen(config.port, () => {
  console.log(`github release endpoint listening on port ${config.port}`);
});
