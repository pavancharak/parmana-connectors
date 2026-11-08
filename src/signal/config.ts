import { assertRazorpayCredential } from "../connectors/razorpay/razorpay-connector.js";
import type { SignalServiceOptions } from "./service.js";

/**
 * Reads the signal service's configuration from the environment. Every value is required, and the service
 * refuses to start with a missing or malformed one: a signal service that answers with a guessed key or
 * audience would be worse than one that does not run.
 */
export function loadSignalConfig(
  env: Readonly<Record<string, string | undefined>>,
): SignalServiceOptions {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `${name} is required; the Razorpay signal service refuses to start without it`,
      );
    }
    return value.trim();
  };

  const audience = required("PARMANA_SIGNAL_AUDIENCE");
  const url = new URL(audience);
  if (url.protocol !== "https:") {
    throw new Error("PARMANA_SIGNAL_AUDIENCE must be an https URL");
  }

  const credential = required("RAZORPAY_CORE_READ_KEY");
  assertRazorpayCredential(credential, env.PARMANA_ALLOW_LIVE_KEYS === "true");

  const sourceName = env.PARMANA_SIGNAL_SOURCE_NAME?.trim();
  if (sourceName !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(sourceName)) {
    throw new Error(
      "PARMANA_SIGNAL_SOURCE_NAME must be lowercase letters, digits and hyphens, 63 characters at most",
    );
  }

  return {
    ...(sourceName !== undefined && sourceName !== "" && { source: sourceName }),
    audience: url.href,
    parmanaPublicKeyPem: required("PARMANA_SIGNAL_PARMANA_PUBLIC_KEY_PEM"),
    parmanaKeyId: env.PARMANA_SIGNAL_PARMANA_KEY_ID?.trim() || "default",
    signingKeyPem: required("PARMANA_SIGNAL_SIGNING_KEY_PEM"),
    signingKeyId: env.PARMANA_SIGNAL_SIGNING_KEY_ID?.trim() || "signal-1",
    credential,
  };
}
