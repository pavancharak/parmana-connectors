/**
 * Runs the GitHub external endpoint as an HTTP server.

Run it with: npx tsx src/external/github-release-server.ts
 *
 * Environment (all required):
 *   PARMANA_PUBLIC_KEY_PEM   Parmana's public key, PEM. From client.publicKey("default").
 *   ENDPOINT_URL             This endpoint's URL exactly as registered in Parmana. Serve it over HTTPS
 *                            behind a TLS-terminating proxy.
 *   GITHUB_APP_CREDENTIAL    "<app id>:<installation id>:<base64 of the App's PEM key>".
 *
 * Optional:
 *   PORT                     Default 8080.
 *
 * It accepts POST only, with a JSON body of at most 256 KiB, and answers with the
 * endpoint's status and JSON body. Nothing is logged except the start-up line.
 */
import { createServer } from "node:http";

import { verifyParmanaRelease } from "@parmana/sdk";

import { createGitHubReleaseEndpoint } from "../connectors/github/external-endpoint.js";

const MAX_BODY_BYTES = 256 * 1024;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required. Its value is not shown.`);
  }
  return value.trim();
}

const publicKeyPem = required("PARMANA_PUBLIC_KEY_PEM");
const audience = required("ENDPOINT_URL");
const credential = required("GITHUB_APP_CREDENTIAL");
const port = Number(process.env["PORT"] ?? 8080);

const handle = createGitHubReleaseEndpoint({ verify: verifyParmanaRelease, publicKeys: { default: publicKeyPem }, audience, credential });

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

server.listen(port, () => {
  console.log(`github release endpoint listening on port ${port}`);
});
