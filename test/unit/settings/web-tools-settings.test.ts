import { describe, expect, it } from "vitest";
import { packB64 } from "../../../src/secrets/aead";
import { EXA_API_KEY_SECRET_NAME } from "../../../src/agent/web-tools";
import {
  deleteExaApiKey,
  getWebToolsSettingsView,
  saveExaApiKey,
} from "../../../src/settings/web-tools-settings";
import type { Env } from "../../../src/env";

// Minimal in-memory KVNamespace stand-in, matching the style used by
// test/unit/sandbox/env-secrets.test.ts.
function fakeKv(): KVNamespace {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...map.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

function fakeEnv(): Env {
  return {
    SECRETS_KV: fakeKv(),
    SECRETS_STORE_KEK_RAW_B64: packB64(new Uint8Array(32).fill(7)),
  } as unknown as Env;
}

describe("web-tools-settings", () => {
  it("reports absent by default", async () => {
    const env = fakeEnv();
    const view = await getWebToolsSettingsView(env, "ws1");
    expect(view).toEqual({
      exaSecretPresent: false,
      exaSecretUpdatedAt: null,
      webSearchEnabled: false,
    });
  });

  it("set makes the secret present and web search enabled, without exposing the value", async () => {
    const env = fakeEnv();
    const view = await saveExaApiKey(env, "ws1", "exa-key-value");
    expect(view.exaSecretPresent).toBe(true);
    expect(view.webSearchEnabled).toBe(true);
    expect(view.exaSecretUpdatedAt).not.toBeNull();
    expect(JSON.stringify(view)).not.toContain("exa-key-value");

    const read = await getWebToolsSettingsView(env, "ws1");
    expect(read).toEqual(view);
  });

  it("delete clears presence and disables web search", async () => {
    const env = fakeEnv();
    await saveExaApiKey(env, "ws1", "exa-key-value");
    const view = await deleteExaApiKey(env, "ws1");
    expect(view).toEqual({
      exaSecretPresent: false,
      exaSecretUpdatedAt: null,
      webSearchEnabled: false,
    });
  });

  it("rejects an empty or whitespace-only value", async () => {
    const env = fakeEnv();
    await expect(saveExaApiKey(env, "ws1", "")).rejects.toThrow();
    await expect(saveExaApiKey(env, "ws1", "   ")).rejects.toThrow();
  });

  it("uses the shared EXA_API_KEY_SECRET_NAME constant for storage", async () => {
    const env = fakeEnv();
    await saveExaApiKey(env, "ws1", "exa-key-value");
    const { createWorkspaceSecretsServices } = await import("../../../src/secrets");
    const { writer } = createWorkspaceSecretsServices(env);
    const metadata = await writer.getMetadata("ws1", EXA_API_KEY_SECRET_NAME);
    expect(metadata).not.toBeNull();
  });
});
