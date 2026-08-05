import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type EnvWithArtifactsHost = typeof env & { ARTIFACTS_HOST?: string };

describe("artifact host gate", () => {
  let previousArtifactsHost: string | undefined;

  beforeEach(() => {
    previousArtifactsHost = (env as EnvWithArtifactsHost).ARTIFACTS_HOST;
    (env as EnvWithArtifactsHost).ARTIFACTS_HOST = "artifacts.example.com";
  });

  afterEach(() => {
    if (previousArtifactsHost === undefined) {
      delete (env as EnvWithArtifactsHost).ARTIFACTS_HOST;
    } else {
      (env as EnvWithArtifactsHost).ARTIFACTS_HOST = previousArtifactsHost;
    }
  });

  it("returns 404 for / on the artifact host instead of serving SPA assets", async () => {
    const res = await SELF.fetch("https://artifacts.example.com/");

    expect(res.status).toBe(404);
  });

  it("routes artifact host /v/ requests through the signed serve handler", async () => {
    const res = await SELF.fetch("https://artifacts.example.com/v/bad-token/art_fake/");

    expect(res.status).toBe(401);
  });

  it("does not handle /v/ on the app host", async () => {
    const res = await SELF.fetch("https://nadi.test/v/bad-token/art_fake/");

    expect(res.status).not.toBe(401);
  });
});
