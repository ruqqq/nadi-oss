import { describe, expect, it } from "vitest";
import {
  SYSTEM_DAYTONA_PROFILES,
  resolveDaytonaConfiguration,
} from "../../../src/compute/daytona-config";
import type { DaytonaProviderConfig } from "../../../src/compute/types";
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

function fakeEnv(daytonaApiKey?: string): Env {
  return {
    DAYTONA_API_KEY: daytonaApiKey,
    SECRETS_KV: fakeKv(),
    SECRETS_STORE_KEK_RAW_B64: packB64(new Uint8Array(32)),
  } as unknown as Env;
}

const providerConfig: DaytonaProviderConfig = {
  kind: "daytona",
  apiKeySecretName: "sandbox:daytona",
  apiUrl: "https://workspace.example",
  target: "workspace-target",
  profiles: {
    small: { kind: "image", value: "workspace-small" },
    medium: { kind: "snapshot", value: "workspace-medium" },
  },
};

describe("resolveDaytonaConfiguration", () => {
  it("keeps system profiles immutable at runtime", () => {
    expect(Object.isFrozen(SYSTEM_DAYTONA_PROFILES)).toBe(true);
    expect(Object.isFrozen(SYSTEM_DAYTONA_PROFILES.small)).toBe(true);
    expect(Object.isFrozen(SYSTEM_DAYTONA_PROFILES.medium)).toBe(true);

    expect(Reflect.set(SYSTEM_DAYTONA_PROFILES.small, "value", "changed")).toBe(false);
    expect(
      Reflect.set(SYSTEM_DAYTONA_PROFILES, "small", {
        kind: "snapshot",
        value: "changed",
      }),
    ).toBe(false);
    expect(SYSTEM_DAYTONA_PROFILES).toEqual({
      small: { kind: "snapshot", value: "nadi-small" },
      medium: { kind: "snapshot", value: "nadi-medium" },
    });
  });

  it("uses a present system key and fixed snapshots when no workspace key exists", async () => {
    const result = await resolveDaytonaConfiguration({
      env: fakeEnv("  system-key  "),
      workspaceId: "ws-1",
      providerConfig,
    });

    expect(result).toEqual({
      mode: "system",
      apiKey: "  system-key  ",
      apiUrl: null,
      target: null,
      profiles: SYSTEM_DAYTONA_PROFILES,
    });
  });

  it("uses only the workspace bundle when a workspace key exists", async () => {
    const env = fakeEnv("system-key");
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek("ws-1");
    await writer.set("ws-1", providerConfig.apiKeySecretName, "workspace-key");

    const result = await resolveDaytonaConfiguration({
      env,
      workspaceId: "ws-1",
      providerConfig,
    });

    expect(result).toEqual({
      mode: "byok",
      apiKey: "workspace-key",
      apiUrl: providerConfig.apiUrl,
      target: providerConfig.target,
      profiles: providerConfig.profiles,
    });
  });

  it("treats a blank system key as missing", async () => {
    const result = await resolveDaytonaConfiguration({
      env: fakeEnv("   "),
      workspaceId: "ws-1",
      providerConfig,
    });

    expect(result.mode).toBe("system");
    expect(result.apiKey).toBeNull();
  });

  it("infers mode from the workspace key regardless of system availability", async () => {
    const system = await resolveDaytonaConfiguration({
      env: fakeEnv(),
      workspaceId: "ws-1",
      providerConfig,
    });
    const env = fakeEnv();
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek("ws-1");
    await writer.set("ws-1", providerConfig.apiKeySecretName, "workspace-key");
    const byok = await resolveDaytonaConfiguration({ env, workspaceId: "ws-1", providerConfig });

    expect(system.mode).toBe("system");
    expect(byok.mode).toBe("byok");
  });
});
