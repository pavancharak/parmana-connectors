import type { GenericConnector } from "../connector-contract.js";
import { assertRazorpayCredential, createRazorpayConnector } from "../connectors/razorpay/razorpay-connector.js";

/**
 * The connectors this service can run. Adding one means adding a case to each
 * switch below, so a connector cannot be selected without its credential rules.
 */
export const CONNECTOR_NAMES = ["razorpay"] as const;

export type ConnectorName = (typeof CONNECTOR_NAMES)[number];

export function isConnectorName(value: string): value is ConnectorName {
  return (CONNECTOR_NAMES as readonly string[]).includes(value);
}

/** The environment variable that holds the connector's credential. */
export function credentialVariableFor(name: ConnectorName): string {
  switch (name) {
    case "razorpay":
      return "RAZORPAY_KEY_PAIR";
  }
}

/** Throws a ConnectorError when the credential cannot be used. The message never includes its value. */
export function assertCredentialUsable(name: ConnectorName, value: string, allowLiveKeys: boolean): void {
  switch (name) {
    case "razorpay":
      assertRazorpayCredential(value, allowLiveKeys);
      return;
  }
}

export function createConnector(name: ConnectorName, options: { readonly allowLiveKeys: boolean }): GenericConnector {
  switch (name) {
    case "razorpay":
      return createRazorpayConnector({ allowLiveKeys: options.allowLiveKeys });
  }
}
