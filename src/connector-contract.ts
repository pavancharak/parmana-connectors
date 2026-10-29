/**
 * The contract between the connectors and the code that runs them. It has no
 * dependencies, so a vendor connector can import it without pulling in the
 * manifest engine or any other connector.
 */

/**
 * Shapes mirror @parmana/connector-sdk. A caller resolves the credential and
 * passes it in; this connector never looks up secrets itself.
 */
export interface CredentialHandle {
  readonly providerId: string;
  readonly credentialId: string;
  readonly value: string;
}

export interface ConnectorRequest {
  readonly capability: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** The action's target, when the caller has one. The generic connector does not use it. */
  readonly target?: string;
  /** Parmana's businessTransactionId. Connectors that must act once use it as a receipt. */
  readonly businessTransactionId?: string;
}

export interface ConnectorExecutionContext {
  readonly credential: CredentialHandle;
  readonly timeoutMs: number;
}

export interface ConnectorResponse {
  readonly success: true;
  readonly metadata: { readonly status: number; readonly body: unknown };
}

export type ConnectorErrorCode =
  | "unknown_capability"
  | "invalid_input"
  | "credential_invalid"
  | "upstream_error"
  | "timeout";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;

  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

export interface GenericConnector {
  readonly system: string;
  /** Every capability in the manifest, read and write. */
  readonly capabilities: readonly string[];
  execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse>;
}
