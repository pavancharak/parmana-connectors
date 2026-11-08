import type { IncomingMessage, ServerResponse } from "node:http";

import { loadSignalConfig } from "../src/signal/config.js";
import { createSignalService } from "../src/signal/service.js";

/**
 * Vercel serves this file at /api/refund-payment. It is the Razorpay payment signal service that
 * parmana-core queries. The configuration is read once per warm instance. A missing setting answers 500
 * with no detail, so the function never starts half-configured and no secret is shown.
 */
type Handle = (req: IncomingMessage, res: ServerResponse) => void;

let handle: Handle | undefined;

export default function refundPayment(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (handle === undefined) {
    try {
      handle = createSignalService(loadSignalConfig(process.env));
    } catch {
      res.writeHead(500, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({ error: "the signal service is not configured" }),
      );
      return;
    }
  }
  handle(req, res);
}
