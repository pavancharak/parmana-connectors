# G-128 and G-129: credential isolation and the inbound bypass

As of 2026-11-06. Companion to the open gaps in parmana-core's `docs/internal/VERIFICATION-GAPS.md`.

## Summary

Two gaps stay open in Parmana's own gap log. Neither can be closed by code alone.

- **G-128:** code on the same host as a connector can read the connector's credential. The fix is deployment: separate users or containers, a secrets store with per-workload identity, short-lived credentials, a key scoped to one action, and an egress allowlist. Code can reduce the risk but cannot remove it from inside the connector's own process.
- **G-129:** an agent that calls a business system directly never reaches Parmana, so no policy, approval or record applies. The fix is that the business system refuses writes that do not come through Parmana. RFC-0024 decided this is required. The check endpoint exists, but it does not yet evaluate policy (G-142).

The decisions needed are listed below. The first is whether to finish moving vendor credentials out of parmana-core, which removes G-128 for core.

As of 2026-11-06, no change has been made to any repository for either gap.

## Current state

| Item | Where it stands | Source |
| --- | --- | --- |
| Core reads vendor credentials from its own environment | Open, G-128 | `packages/api/src/bootstrap/secrets/EnvSecretsProvider.ts` |
| Connector services hold their own keys | Built. Razorpay runs in Vercel production, with no production traffic | parmana-connectors README |
| Vendor connectors moved out of core | Zerodha, Slack, Paytm, GitHub, HubSpot removed from core. Razorpay, GitHub, HubSpot and Slack still have open registrations in core | parmana-connectors README, ADR-0018 |
| Razorpay test run | 4 of 4 checks on 29 Oct 2026, test mode only. No signed release has run end to end through the deployed service. Live money off | parmana-connectors README |
| Bearer path into the connector | Open unless `PARMANA_RELEASE_ONLY=true`. Fixed in parmana-connect PR #32, not deployed | G-130 |
| Core and connector run together | Not done. The connector endpoint needs a public HTTPS address, and no local run is possible | G-133 |
| Connector's production key | Not pinned. Any release signed by the given key is accepted | G-134 |
| Inbound check endpoint | Exists and tested. No business system calls it, and it does not evaluate policy | G-129, G-142 |
| Google AX | No approval policy, no egress control and no tool-call hook in the code. MCP servers are called directly by the agent | google/ax at 241bc4d |

The connectors acceptance test under `examples/google-ax-refund` passes 11 tests. It shows that the connector refuses bad releases and never returns its credential. It does not show that code on the same host cannot read the key.

## G-128: code on the connector host can read its key

The gap: in env mode, the credential is read from the server's environment. Any code in the same process, container or host that can read that environment can read the key.

The fix works in two parts. The first removes the vendor key from parmana-core. The second limits who can read the key inside each connector.

**Part 1: finish moving vendor credentials out of parmana-core.**

1. Register Razorpay, GitHub, HubSpot and Slack in their connector services, as ADR-0018 describes.
2. Remove those vendors' credential providers from core's env mode.
3. Confirm that core's environment and files contain no vendor key. Add a test that checks this. Gap G-146 describes the same kind of probe.

When Part 1 is done, G-128 is closed for parmana-core.

**Part 2: limit who can read the key inside each connector.**

1. Stop storing the key in a plain environment variable. Use a secrets store with a workload identity, such as a cloud service account or the platform's OIDC identity. The connector fetches the key when it starts.
2. Use short-lived credentials where the vendor supports them. Otherwise rotate the key on a fixed schedule and immediately on any suspected exposure.
3. Run each connector in its own container or service, under its own identity. Do not run it on the same host as anything that executes user-supplied code, such as a dashboard, a plugin or an agent sandbox.
4. Scope the key at the vendor. A Razorpay key that can only refund limits the damage from a leak.
5. Restrict the connector's outbound traffic to its vendor's API host. Without this, a connector can be used to send the key elsewhere.

**What remains after Part 2**

Code that runs as the connector's own user can still read the key from memory. Separate users, containers or secrets stores with per-workload identity narrow who can read it. They cannot stop code that runs inside the connector process. That residual risk is a deployment decision: accept it, or run the connector on infrastructure that never runs other code.

The repositories do not yet implement any part of Part 2. The connector reads `RAZORPAY_KEY_PAIR` from its environment today.

## G-129: an agent can reach a business system directly

The gap: an agent run by a customer or partner calls a business system directly. No policy decides that call, no approval is required, and no record is written.

RFC-0024 decided the design: an inbound agent must not reach a business system without Parmana's check. The fix has three parts.

1. **The business system refuses writes that do not come through Parmana.** Put a gateway in front of it. The gateway requires a valid Parmana decision for each write. Network rules, or the system's own credentials, make the gateway the only route to the system.
2. **The agent never holds the system's credentials.** The gateway holds them. The agent can then call the system only through the check. This turns the README's outbound rules from a documented promise into an enforced one.
3. **The check applies to every write path,** including any path the customer's agent builds itself. An operator can test this with a probe that tries to reach the system without the gateway. Gap G-146 describes that probe, and it is not done.

**What code can and cannot do**

- Code can provide the gateway and the check. `POST /v1/inbound/checks` exists and is tested. It does not yet evaluate the capability's policy (G-142), so the check is incomplete until G-142 is closed.
- Code cannot force a customer's agent to use the gateway. The customer must route its calls through it.
- Code cannot make the business system refuse other callers. That is configuration of the system, under the operator's control.

**What remains**

The gap stays open until the check evaluates policy (G-142), the probe passes (G-146), and each business system is configured to refuse writes that did not come through the gateway.

## Decisions needed

The repositories do not name who decides each item, so the owner column is left for you to fill in.

| Decision | Options | Recommendation | Owner |
| --- | --- | --- | --- |
| Finish moving vendor keys out of core (G-128, Part 1) | Finish the migration, or keep the keys in core and accept the same-host exposure | Finish the migration | |
| Where connector keys live (G-128, Part 2) | Secrets store with workload identity, or the platform's environment variables | Secrets store with workload identity | |
| Isolation level for connectors | Separate containers per vendor, or a shared service | Separate containers per vendor | |
| Whether to accept residual same-process exposure | Accept and record it in the threat model, or move to separate infrastructure | Accept and record it, unless the vendor key can move money without a second check | |
| Making the inbound check mandatory (G-129) | RFC-0024 option A, already decided. Its rollout is open | Proceed with option A, starting with one business system | |
| Scope of the first business system for the gateway | Refunds only, or all writes | Refunds only | |
| Whether to pin the connector's production key (G-134) | Pin now, or after the second-channel check | Pin now, once the key fingerprint is confirmed by a second channel | |

The recommendations are a starting point. They do not reflect a decision already made.

## Order of work

Each step has a check that shows it is done. A step is not done until its check passes.

1. **Confirm the Razorpay key fingerprint through a second channel, and pin it (G-134).** Check: the connector refuses a release signed by any other key.
2. **Register Razorpay in its connector service and remove its key from core (G-128, Part 1).** Check: a test confirms that core's environment and files contain no Razorpay key.
3. **Repeat step 2 for GitHub, HubSpot and Slack.** Check: the same test covers all four.
4. **Move the connector key to a secrets store with workload identity, and run each connector in its own container (G-128, Part 2).** Check: the connector reads its key from the store at startup, and no other service can read it.
5. **Scope the vendor keys and restrict connector egress to the vendor API host (G-128, Part 2).** Check: a connector call to any other host fails.
6. **Turn on `PARMANA_RELEASE_ONLY=true` after redeploying parmana-connect (G-130).** Check: a bearer request to the connector returns 403.
7. **Run one signed release end to end between core and the deployed connector (G-133).** Check: the connector runs the action once, and a repeated release gets the stored answer.
8. **Make the inbound check evaluate policy (G-142), then route one business system's refunds through the gateway (G-129).** Check: the business system refuses a refund that did not come through the gateway.
9. **Run the no-bypass probe on each business system (G-146).** Check: the probe's attempt to write without the gateway fails.

Steps 1 to 5 close G-128 for the connectors that move. They do not close the residual same-process exposure, which the decision table covers. Steps 8 and 9 close G-129 for one system. Other systems need the same steps.

The repositories contain tests for parts of steps 6 and 7 (`tests/release-only.test.ts`, `tests/release-ledger.test.ts`). They have not been run against a deployed connector, and G-133 says so.

## Sources

All paths are as read on 2026-11-06. The repositories are `pavancharak/parmana-core` and `pavancharak/parmana-connectors` (both on `main`, with `claude/serene-gates-t0l2ff` in connectors), and `google/ax` at commit `241bc4d`.

- `docs/internal/VERIFICATION-GAPS.md` in parmana-core: entries G-128, G-129, G-130 to G-138, and G-142, G-146 as referenced. Read at the entries' current text.
- `docs/internal/rfcs/RFC-0024-Inbound-Agent-Authorization.md` in parmana-core: the decision for option A. Referenced in G-129, not reread for this document.
- `packages/api/src/bootstrap/secrets/EnvSecretsProvider.ts` in parmana-core: the pass-through credential provider behind G-128.
- `README.md` and `SETUP.md` in parmana-connectors: the connector service's status, its settings, and the reason for keeping credentials out of core.
- `examples/google-ax-refund/refund.acceptance.test.ts` and `README.md` in parmana-connectors: the 11 acceptance tests and their limits.
- `pkg/apis/v1alpha1/ax.proto`, `SECURITY.md`, `docs/roadmap.md`, `internal/server/server.go` in `google/ax`: the resource types, the lack of API authentication, the roadmap items, and the server with no gRPC interceptor.
- ADR-0018 (connector migration out of parmana-core): cited in the connectors README. Not opened from its own file for this document.

Not checked for this document: a running deployment of either service, and the vendor's own documentation for key scopes and short-lived credentials.
