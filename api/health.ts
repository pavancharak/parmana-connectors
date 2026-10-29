import type { IncomingMessage, ServerResponse } from "node:http";

/** Reports that the function is running. It does not read the settings or check the database, like GET /health in the service. */
export default function health(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "UP" }));
}
