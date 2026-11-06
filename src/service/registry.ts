import type { GenericConnector } from "../connector-contract.js";
import { createGitHubConnector, parseGitHubAppCredential } from "../connectors/github/github-connector.js";
import { createHubSpotConnector, parseHubSpotPrivateAppToken } from "../connectors/hubspot/hubspot-connector.js";
import { createPaytmConnector, parsePaytmCredential } from "../connectors/paytm/paytm-connector.js";
import { createSlackConnector, parseSlackBotToken } from "../connectors/slack/slack-connector.js";
import { assertRazorpayCredential, createRazorpayConnector } from "../connectors/razorpay/razorpay-connector.js";
import { createZohoConnector, parseZohoAccessToken } from "../connectors/zoho/zoho-connector.js";

/**
 * The connectors this service can run. Adding one means adding a case to each
 * switch below, so a connector cannot be selected without its credential rules.
 */
export const CONNECTOR_NAMES = ["github", "hubspot", "paytm", "razorpay", "slack", "zoho"] as const;

export type ConnectorName = (typeof CONNECTOR_NAMES)[number];

export function isConnectorName(value: string): value is ConnectorName {
  return (CONNECTOR_NAMES as readonly string[]).includes(value);
}

/** The environment variable that holds the connector's credential. */
export function credentialVariableFor(name: ConnectorName): string {
  switch (name) {
    case "github":
      return "GITHUB_APP_CREDENTIAL";
    case "hubspot":
      return "HUBSPOT_PRIVATE_APP_TOKEN";
    case "paytm":
      return "PAYTM_MERCHANT_CREDENTIAL";
    case "razorpay":
      return "RAZORPAY_KEY_PAIR";
    case "slack":
      return "SLACK_BOT_TOKEN";
    case "zoho":
      return "ZOHO_ACCESS_TOKEN";
  }
}

/** Throws a ConnectorError when the credential cannot be used. The message never includes its value. */
export function assertCredentialUsable(name: ConnectorName, value: string, allowLiveKeys: boolean): void {
  switch (name) {
    case "github":
      parseGitHubAppCredential(value);
      return;
    case "hubspot":
      parseHubSpotPrivateAppToken(value);
      return;
    case "paytm":
      parsePaytmCredential(value);
      return;
    case "razorpay":
      assertRazorpayCredential(value, allowLiveKeys);
      return;
    case "slack":
      parseSlackBotToken(value);
      return;
    case "zoho":
      parseZohoAccessToken(value);
      return;
  }
}

export function createConnector(name: ConnectorName, options: { readonly allowLiveKeys: boolean }): GenericConnector {
  switch (name) {
    case "github":
      return createGitHubConnector();
    case "hubspot":
      return createHubSpotConnector();
    case "paytm":
      // Staging only. Production Paytm needs its own setting and approval, so the
      // live-keys flag does not enable it here.
      return createPaytmConnector({ environment: "staging", allowProduction: false });
    case "razorpay":
      return createRazorpayConnector({ allowLiveKeys: options.allowLiveKeys });
    case "slack":
      return createSlackConnector();
    case "zoho":
      // The organization id is not a secret, but it must be set. The connector refuses to start without it.
      return createZohoConnector({ organizationId: process.env["ZOHO_ORGANIZATION_ID"] ?? "" });
  }
}
