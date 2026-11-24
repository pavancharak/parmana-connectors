import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GitHubEndpointConfigError, loadGitHubEndpointConfig } from "../../../src/external/github-endpoint-config.js";

const { publicKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const GOOD = {
  PARMANA_PUBLIC_KEY: PEM,
  PARMANA_RELEASE_AUDIENCE: "https://github-endpoint.example.test/release",
  GITHUB_APP_CREDENTIAL: "424242:99887766:dGVzdA==",
};

describe("GitHub endpoint configuration", () => {
  it("reads the key from PARMANA_PUBLIC_KEY, the https audience, the credential and the default port", () => {
    const config = loadGitHubEndpointConfig(GOOD);
    expect(config.audience).toBe("https://github-endpoint.example.test/release");
    expect(config.port).toBe(8080);
    expect(config.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("reads the key from PARMANA_PUBLIC_KEY_FILE when no PEM text is given", () => {
    const { PARMANA_PUBLIC_KEY: _ignored, ...rest } = GOOD;
    const config = loadGitHubEndpointConfig({ ...rest, PARMANA_PUBLIC_KEY_FILE: "/secure/parmana.pub.pem" }, () => PEM);
    expect(config.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("accepts a PEM pasted with literal \\n sequences", () => {
    const pasted = PEM.replace(/\n/g, "\\n");
    expect(loadGitHubEndpointConfig({ ...GOOD, PARMANA_PUBLIC_KEY: pasted }).publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("refuses both PARMANA_PUBLIC_KEY and PARMANA_PUBLIC_KEY_FILE", () => {
    expect(() => loadGitHubEndpointConfig({ ...GOOD, PARMANA_PUBLIC_KEY_FILE: "/x.pem" }, () => PEM)).toThrow(/not both/);
  });

  it("refuses a missing key", () => {
    const { PARMANA_PUBLIC_KEY: _ignored, ...rest } = GOOD;
    expect(() => loadGitHubEndpointConfig(rest)).toThrow(/is required/);
  });

  it("refuses a key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => loadGitHubEndpointConfig({ ...GOOD, PARMANA_PUBLIC_KEY: rsa })).toThrow(/Ed25519/);
  });

  it("refuses an audience that is not https", () => {
    expect(() => loadGitHubEndpointConfig({ ...GOOD, PARMANA_RELEASE_AUDIENCE: "http://github-endpoint.example.test/release" })).toThrow(/https/);
  });

  it("refuses a missing audience, and does not accept the old ENDPOINT_URL name", () => {
    const { PARMANA_RELEASE_AUDIENCE: _ignored, ...rest } = GOOD;
    expect(() => loadGitHubEndpointConfig({ ...rest, ENDPOINT_URL: "https://github-endpoint.example.test/release" })).toThrow(/PARMANA_RELEASE_AUDIENCE is required/);
  });

  it("refuses a missing GitHub credential", () => {
    const { GITHUB_APP_CREDENTIAL: _ignored, ...rest } = GOOD;
    expect(() => loadGitHubEndpointConfig(rest)).toThrow(/GITHUB_APP_CREDENTIAL is required/);
  });

  it("refuses a port that is not a whole number in range", () => {
    expect(() => loadGitHubEndpointConfig({ ...GOOD, PORT: "70000" })).toThrow(GitHubEndpointConfigError);
  });
});
