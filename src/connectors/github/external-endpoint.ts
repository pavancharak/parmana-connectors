import { ConnectorError, type ConnectorResponse } from "../../connector-contract.js";
import {
  createGitHubConnector,
  GITHUB_COMMENT_CAPABILITY,
  GITHUB_PR_FETCH_CAPABILITY,
  GITHUB_PR_MERGE_CAPABILITY,
} from "./github-connector.js";
/**
 * The release as this endpoint reads it. The verifier is passed in, so this
 * folder imports nothing from @parmana/sdk. The wiring that supplies
 * verifyParmanaRelease lives outside the connector folder (src/external/).
 */
export interface ParmanaRelease {
  readonly capability: string;
  readonly target: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly businessTransactionId: string;
}

export interface VerifyReleaseOptions {
  readonly publicKeys: Readonly<Record<string, string>>;
  readonly audience: string;
  readonly isAlreadyExecuted: (businessTransactionId: string) => boolean;
  readonly now?: Date;
}

/** Same result shape as verifyParmanaRelease in @parmana/sdk. */
export type VerifyRelease = (
  body: unknown,
  options: VerifyReleaseOptions,
) => Promise<
  | { readonly valid: true; readonly release: ParmanaRelease; readonly alreadyExecuted: boolean }
  | { readonly valid: false; readonly errors: readonly string[] }
>;

/**
 * The GitHub connector as an external connector endpoint (ADR-0013).
 *
 * Parmana releases each approved request for a capability here as a signed
 * body: `{ release, signature }`. This handler checks the signature and the
 * release, then acts with the GitHub App credential, which only this endpoint
 * holds. Parmana's public key and the endpoint's registered URL come from the
 * operator.
 *
 * All three GitHub capabilities are served: `github:pr-fetch`, `github:pr-merge`
 * and `github:comment`. Parmana releases a write only after its approvals, and
 * the release carries them, so the endpoint does not check approvals again. A
 * release for any other capability is refused before GitHub is called. A release
 * already answered is answered with the first answer, never acted on twice.
 *
 * The first answers are kept in memory by default. A restart forgets them, so
 * production needs a durable store passed in as `answers`.
 */

/** The capabilities this endpoint serves: the three GitHub capabilities. */
export const GITHUB_ENDPOINT_CAPABILITIES: ReadonlySet<string> = new Set([
  GITHUB_PR_FETCH_CAPABILITY,
  GITHUB_PR_MERGE_CAPABILITY,
  GITHUB_COMMENT_CAPABILITY,
]);

export interface GitHubReleaseEndpointOptions {
  /** Checks the signed body. Pass verifyParmanaRelease from @parmana/sdk. */
  readonly verify: VerifyRelease;
  /** Key id to PEM. Usually `{ default: <PEM from client.publicKey("default")> }`. */
  readonly publicKeys: Readonly<Record<string, string>>;
  /** This endpoint's URL exactly as registered in Parmana. */
  readonly audience: string;
  /** The GitHub App credential, `<app id>:<installation id>:<base64 PEM>`. Never logged. */
  readonly credential: string;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** First answers by businessTransactionId. Use a durable store in production. */
  readonly answers?: Map<string, Record<string, unknown>>;
  readonly now?: () => Date;
  /** Time limit for one GitHub call, in milliseconds. */
  readonly timeoutMs?: number;
}

export interface EndpointAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export function createGitHubReleaseEndpoint(options: GitHubReleaseEndpointOptions) {
  const answers = options.answers ?? new Map<string, Record<string, unknown>>();
  const connector = createGitHubConnector(options.fetch !== undefined ? { fetch: options.fetch } : {});

  return async (body: unknown): Promise<EndpointAnswer> => {
    const verification = await options.verify(body, {
      publicKeys: options.publicKeys,
      audience: options.audience,
      isAlreadyExecuted: (id) => answers.has(id),
      ...(options.now !== undefined ? { now: options.now() } : {}),
    });

    if (!verification.valid) {
      // Parmana records anything but 200 as an unknown outcome. Nothing was done here.
      return { status: 401, body: { errors: verification.errors } };
    }

    const release: ParmanaRelease = verification.release;

    const first = answers.get(release.businessTransactionId);
    if (first !== undefined) {
      return { status: 200, body: first };
    }

    if (!GITHUB_ENDPOINT_CAPABILITIES.has(release.capability)) {
      // Refused before any GitHub call. Nothing was done, so nothing is recorded.
      return { status: 403, body: { error: "This endpoint does not serve that capability.", capability: release.capability } };
    }

    const answer = await act(release);
    answers.set(release.businessTransactionId, answer);
    return { status: 200, body: answer };
  };

  async function act(release: ParmanaRelease): Promise<Record<string, unknown>> {
    const base = { businessTransactionId: release.businessTransactionId, capability: release.capability };
    try {
      const response: ConnectorResponse = await connector.execute(
        {
          capability: release.capability,
          target: release.target,
          parameters: release.parameters as Record<string, unknown>,
          businessTransactionId: release.businessTransactionId,
        },
        {
          credential: { providerId: "github-app", credentialId: "GITHUB_APP_CREDENTIAL", value: options.credential },
          timeoutMs: options.timeoutMs ?? 10_000,
        },
      );
      return { ...base, success: true, result: response.metadata.body };
    } catch (error) {
      if (error instanceof ConnectorError) {
        // The message is the connector's own, and it never holds the credential.
        return { ...base, success: false, errorCode: error.code, message: error.message };
      }
      return { ...base, success: false, errorCode: "upstream_error", message: "The GitHub connector failed unexpectedly." };
    }
  }
}
