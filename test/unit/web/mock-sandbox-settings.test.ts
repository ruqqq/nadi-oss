import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "../../../web/node_modules/msw/node";
import {
  clearDaytonaOverride,
  clearSpritesOverride,
  saveDaytonaSecret,
  saveSpritesSecret,
  saveWorkspaceSandboxSettings,
  testConnection,
} from "../../../web/src/sandbox-settings-api";
import { restHandlers } from "../../../web/src/mocks/rest";
import { getStore, resetStore, seedStore } from "../../../web/src/mocks/store";

const server = setupServer(...(restHandlers as unknown as Parameters<typeof setupServer>));
const mswFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? new URL(input, "http://localhost:3000").toString() : input;
  return fetch(url, init);
};

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetStore();
});
afterAll(() => server.close());

describe("mock Daytona settings mutations", () => {
  it("seeds persistent system-managed and BYOK scenarios", () => {
    expect(seedStore("daytona-system").sandbox).toMatchObject({
      daytonaMode: "system",
      daytonaAvailable: true,
      daytonaSecretPresent: false,
      workspace: {
        provider: "daytona",
        providerConfig: {
          kind: "daytona",
          apiKeySecretName: "sandbox:daytona",
          apiUrl: null,
          target: null,
          profiles: { small: null, medium: null },
        },
      },
    });

    expect(seedStore("daytona-byok").sandbox).toMatchObject({
      daytonaMode: "byok",
      daytonaAvailable: true,
      daytonaSecretPresent: true,
      workspace: { provider: "daytona" },
    });
  });

  it("enters BYOK mode and derives availability from secret and profile completeness", async () => {
    seedStore("default");
    const config = getStore().sandbox.workspace?.providerConfig;
    if (!config || config.kind !== "daytona") throw new Error("expected Daytona fixture");
    config.profiles.medium = null;

    await expect(saveDaytonaSecret({ value: "workspace-key" }, mswFetch)).resolves.toMatchObject({
      daytonaMode: "byok",
      daytonaAvailable: false,
      daytonaSecretPresent: true,
    });
  });

  it("resets to scenario system availability instead of assuming system credentials exist", async () => {
    seedStore("default");
    getStore().daytonaSystemAvailable = false;

    await expect(clearDaytonaOverride(mswFetch)).resolves.toMatchObject({
      daytonaMode: "system",
      daytonaAvailable: false,
      daytonaSecretPresent: false,
    });
  });

  it("preserves nested Daytona provider configuration on workspace updates", async () => {
    seedStore("daytona-byok");
    const original = getStore().sandbox.workspace?.providerConfig;
    if (!original || original.kind !== "daytona") throw new Error("expected Daytona fixture");

    await saveWorkspaceSandboxSettings(
      { providerConfig: { kind: "daytona", apiUrl: "https://custom.example/api" } },
      mswFetch,
    );

    expect(getStore().sandbox.workspace?.providerConfig).toEqual({
      ...original,
      apiUrl: "https://custom.example/api",
    });
  });

  it("round-trips provider configuration from Cloudflare to Daytona and back", async () => {
    seedStore("default");
    const workspace = getStore().sandbox.workspace;
    if (!workspace) throw new Error("expected workspace fixture");
    workspace.provider = "cloudflare";
    workspace.providerConfig = { kind: "cloudflare" };
    const daytonaConfig = {
      kind: "daytona" as const,
      apiKeySecretName: "sandbox:custom-daytona",
      apiUrl: "https://daytona.example/api",
      target: "us",
      profiles: {
        small: { kind: "snapshot" as const, value: "snap-small" },
        medium: { kind: "image" as const, value: "daytonaio/workspace:large" },
      },
    };

    const daytona = await saveWorkspaceSandboxSettings(
      { provider: "daytona", providerConfig: daytonaConfig },
      mswFetch,
    );

    expect(daytona.workspace).toMatchObject({
      provider: "daytona",
      providerConfig: daytonaConfig,
    });
    expect(getStore().sandbox.workspace).toMatchObject({
      provider: "daytona",
      providerConfig: daytonaConfig,
    });

    const cloudflare = await saveWorkspaceSandboxSettings(
      { provider: "cloudflare", providerConfig: { kind: "cloudflare" } },
      mswFetch,
    );

    expect(cloudflare.workspace).toMatchObject({
      provider: "cloudflare",
      providerConfig: { kind: "cloudflare" },
    });
    expect(getStore().sandbox.workspace).toMatchObject({
      provider: "cloudflare",
      providerConfig: { kind: "cloudflare" },
    });
  });

  it("tests the effective Daytona availability", async () => {
    seedStore("daytona-system");
    getStore().sandbox.daytonaAvailable = false;

    await expect(testConnection(mswFetch)).resolves.toEqual({
      ok: false,
      phase: "connection",
      error: "missing_secret",
    });

    getStore().sandbox.daytonaAvailable = true;
    await expect(testConnection(mswFetch)).resolves.toEqual({ ok: true });
  });
});

describe("mock Sprites settings mutations", () => {
  it("seeds spritesMode/spritesAvailable/spritesSecretPresent and readiness.sprites", () => {
    expect(seedStore("default").sandbox).toMatchObject({
      spritesMode: "system",
      spritesAvailable: false,
      spritesSecretPresent: false,
      readiness: {
        sprites: { provider: "sprites", ready: true, missingConfig: [], unsupported: [] },
      },
    });
  });

  it("enters BYOK mode on saveSpritesSecret and persists the secret name", async () => {
    seedStore("default");

    await expect(
      saveSpritesSecret({ value: "sprites-key", secretName: "sandbox:sprites" }, mswFetch),
    ).resolves.toMatchObject({
      spritesMode: "byok",
      spritesSecretPresent: true,
    });
  });

  it("resets Sprites to system mode on clearSpritesOverride", async () => {
    seedStore("default");
    await saveSpritesSecret({ value: "sprites-key" }, mswFetch);

    await expect(clearSpritesOverride(mswFetch)).resolves.toMatchObject({
      spritesMode: "system",
      spritesSecretPresent: false,
    });
  });

  it("accepts and persists a sprites providerConfig on the workspace PUT", async () => {
    seedStore("default");

    const result = await saveWorkspaceSandboxSettings(
      {
        provider: "sprites",
        providerConfig: { kind: "sprites", apiKeySecretName: "sandbox:sprites" },
      },
      mswFetch,
    );

    expect(result.workspace).toMatchObject({
      provider: "sprites",
      providerConfig: { kind: "sprites", apiKeySecretName: "sandbox:sprites" },
    });
    expect(getStore().sandbox.workspace).toMatchObject({
      provider: "sprites",
      providerConfig: { kind: "sprites", apiKeySecretName: "sandbox:sprites" },
    });
  });
});
