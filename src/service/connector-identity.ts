/**
 * The connector identity parmana-core signs into every external release. parmana-core's
 * GatewayExternalAdapter sets connectorId to `ext-<capability>`, and its external connector
 * identity module (packages/execution-control, externalConnectorIdentity.ts) names the same
 * format as public. This is the receiving side of that contract: change both together.
 *
 * It is derived from the release's own capability, so a release is bound to the capability
 * it names. An exact match is required; nothing is trimmed, lowercased or prefix-matched.
 */
export const EXTERNAL_CONNECTOR_ID_PREFIX = "ext-";

export function expectedConnectorId(capability: string): string {
  return `${EXTERNAL_CONNECTOR_ID_PREFIX}${capability}`;
}
