/**
 * Whether a real code-host app test-mode credential triple is configured in
 * the environment.
 *
 * Mirrors the other live-availability helper: the live-gated code-host suite needs
 * a real code-host app installation to talk to and cannot run hermetically
 * from a bare clone (see parmana-core packages/api/README.md for the env vars that
 * enable it). Unlike a single API token, this credential is a
 * triple (appId, installationId, privateKey) -- all three are required
 * together to mint anything at all.
 */
export function hasGitHubLiveConfig(): boolean {
  return Boolean(
    process.env.TEST_GITHUB_APP_ID &&
    process.env.TEST_GITHUB_INSTALLATION_ID &&
    process.env.TEST_GITHUB_APP_PRIVATE_KEY,
  );
}

/**
 * Resolves whether the live-gated code-host suite should run, enforcing the
 * same live-credential opt-in as resolveHubSpotLiveGate: a real
 * TEST_GITHUB_* triple being configured is not by itself enough to run
 * against GitHub's real API. ALLOW_LIVE_GITHUB=1 must also be set
 * explicitly, or the suite skips cleanly rather than silently making a
 * real network call -- a default `npm test` on a machine with test
 * credentials configured stays green and side-effect-free. Explicitly
 * requesting a live run with ALLOW_LIVE_GITHUB=1 but no visible
 * credentials is a hard failure, not a skip, for the same reason
 * resolveHubSpotLiveGate treats it that way: explicit intent must never
 * quietly degrade to a silent skip.
 *
 * Deliberately does NOT validate TEST_GITHUB_APP_PRIVATE_KEY's shape the
 * way resolveHubSpotLiveGate validates its token's "pat-" prefix -- a PEM
 * private key has no single fixed prefix to check, and an invalid key
 * fails safely anyway: signGitHubAppJwt's own createSign(...).sign() call
 * throws before any network call is made, so a malformed key can never
 * reach GitHub's API in a way that looks like a real (if wrong) exchange.
 */
export function resolveGitHubLiveGate(suiteLabel: string): boolean {
  const configured = hasGitHubLiveConfig();
  const optedIn = process.env.ALLOW_LIVE_GITHUB === "1";

  if (configured && !optedIn) {
    console.log(
      `${suiteLabel}: GitHub test-mode credentials configured but ALLOW_LIVE_GITHUB=1 not set — ` +
        "skipping live suite. Set ALLOW_LIVE_GITHUB=1 to run it.",
    );
    return false;
  }

  if (optedIn && !configured) {
    throw new Error(
      `${suiteLabel}: ALLOW_LIVE_GITHUB=1 is set — a live run was explicitly requested — but ` +
        "TEST_GITHUB_APP_ID/TEST_GITHUB_INSTALLATION_ID/TEST_GITHUB_APP_PRIVATE_KEY are not all visible " +
        "to this worker. Refusing to silently skip a suite that was explicitly asked to run live.",
    );
  }

  if (!configured) {
    console.log(
      `[SKIP] ${suiteLabel}: TEST_GITHUB_APP_ID/TEST_GITHUB_INSTALLATION_ID/TEST_GITHUB_APP_PRIVATE_KEY ` +
        "not set. See parmana-core packages/api/README.md to enable this suite.",
    );
    return false;
  }

  return true;
}

/**
 * Second gating tier, nested inside resolveGitHubLiveGate's: even once a
 * live run is confirmed, a real target (repository + pull request number)
 * is required for any test that names an actual PR. Only call this once
 * the caller has already confirmed the base live gate is active.
 *
 * There is no mutating (merge) case in this suite -- see
 * github-pr-merge-live.integration.test.ts's own header comment for why:
 * unlike a HubSpot deal's numeric field, a GitHub PR merge has no safe,
 * general revert. This gate exists for the reachability case only, which
 * targets a real repository but a pull request number guaranteed not to
 * exist, so it never mutates anything either way -- TEST_GITHUB_REPOSITORY
 * just needs to be a real repo the configured installation can see.
 */
export function resolveGitHubTestRepositoryGate(
  suiteLabel: string,
): string | undefined {
  const repository = process.env.TEST_GITHUB_REPOSITORY;

  if (repository === undefined) {
    console.log(
      `[SKIP] ${suiteLabel}: TEST_GITHUB_REPOSITORY not set — skipping the live reachability case only; ` +
        "the policy-denial case in this file still runs without it. See parmana-core packages/api/README.md to enable " +
        "this case.",
    );
    return undefined;
  }

  return repository;
}
