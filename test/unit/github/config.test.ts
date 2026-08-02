import { describe, expect, it } from "vitest";
import { getGithubAppConfig } from "../../../src/github/config";
import type { Env } from "../../../src/env";

const full = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "secret",
  GITHUB_APP_SLUG: "nadi-app",
} as unknown as Env;

describe("getGithubAppConfig", () => {
  it("returns config when all fields present", () => {
    expect(getGithubAppConfig(full)).toEqual({
      appId: "123",
      privateKeyPkcs8Pem: full.GITHUB_APP_PRIVATE_KEY,
      clientId: "Iv1.abc",
      clientSecret: "secret",
      slug: "nadi-app",
    });
  });

  it("returns null when any field is missing", () => {
    expect(
      getGithubAppConfig({ ...full, GITHUB_APP_SLUG: undefined } as unknown as Env),
    ).toBeNull();
    expect(getGithubAppConfig({} as unknown as Env)).toBeNull();
  });
});
