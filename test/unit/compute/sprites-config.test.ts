import { describe, expect, it } from "vitest";
import { resolveSpritesConfiguration } from "../../../src/compute/sprites-config";
import type { SpritesProviderConfig } from "../../../src/compute/types";
import type { Env } from "../../../src/env";
import { createWorkspaceSecretsServices, packB64 } from "../../../src/secrets";

function fakeKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function fakeEnv(spritesApiKey?: string): Env {
  return {
    SPRITES_API_KEY: spritesApiKey,
    SECRETS_KV: fakeKv(),
    SECRETS_STORE_KEK_RAW_B64: packB64(new Uint8Array(32)),
  } as unknown as Env;
}

const providerConfig: SpritesProviderConfig = {
  kind: "sprites",
  apiKeySecretName: "sandbox:sprites",
};

describe("resolveSpritesConfiguration", () => {
  it("uses the system env key when no workspace secret metadata exists", async () => {
    const result = await resolveSpritesConfiguration({
      env: fakeEnv("system-key"),
      workspaceId: "ws-1",
      providerConfig,
    });

    expect(result).toEqual({ mode: "system", apiKey: "system-key" });
  });

  it("treats an absent system env key as null", async () => {
    const result = await resolveSpritesConfiguration({
      env: fakeEnv(),
      workspaceId: "ws-1",
      providerConfig,
    });

    expect(result).toEqual({ mode: "system", apiKey: null });
  });

  it("treats a whitespace-only system env key as null", async () => {
    const result = await resolveSpritesConfiguration({
      env: fakeEnv("   "),
      workspaceId: "ws-1",
      providerConfig,
    });

    expect(result.mode).toBe("system");
    expect(result.apiKey).toBeNull();
  });

  it("uses the workspace secret when metadata is present (byok)", async () => {
    const env = fakeEnv("system-key");
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek("ws-1");
    await writer.set("ws-1", providerConfig.apiKeySecretName, "workspace-key");

    const result = await resolveSpritesConfiguration({
      env,
      workspaceId: "ws-1",
      providerConfig,
    });

    expect(result).toEqual({ mode: "byok", apiKey: "workspace-key" });
  });

  it("infers mode from workspace secret metadata regardless of system availability", async () => {
    const system = await resolveSpritesConfiguration({
      env: fakeEnv(),
      workspaceId: "ws-1",
      providerConfig,
    });
    const env = fakeEnv();
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek("ws-1");
    await writer.set("ws-1", providerConfig.apiKeySecretName, "workspace-key");
    const byok = await resolveSpritesConfiguration({ env, workspaceId: "ws-1", providerConfig });

    expect(system.mode).toBe("system");
    expect(byok.mode).toBe("byok");
  });
});
