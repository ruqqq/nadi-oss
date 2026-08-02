import { describe, expect, it } from "vitest";
import { importRawKey, packB64 } from "../../../src/secrets/aead";
import { SecretsError } from "../../../src/secrets/errors";
import {
  buildWorkspaceSecretKey,
  KVWorkspaceSecretsStore,
  KVWorkspaceSecretsWriter,
} from "../../../src/secrets";

class MemoryKV {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(input?: { prefix?: string }): Promise<KVNamespaceListResult<unknown>> {
    const prefix = input?.prefix ?? "";
    return {
      keys: [...this.values.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    };
  }
}

describe("workspace secrets", () => {
  it("creates a workspace DEK and reads back encrypted named secrets", async () => {
    const kv = new MemoryKV();
    const kek = importRawKey(new Uint8Array(32).fill(3));
    const writer = new KVWorkspaceSecretsWriter(kv as unknown as KVNamespace, kek);
    const store = new KVWorkspaceSecretsStore(kv as unknown as KVNamespace, kek);

    await expect(writer.ensureWorkspaceDek("workspace-1")).resolves.toBe(true);
    await writer.set("workspace-1", "provider:openai-oauth", '{"access_token":"tok"}', {
      updatedAt: "2026-06-28T00:00:00.000Z",
    });

    await expect(store.get("workspace-1", "provider:openai-oauth")).resolves.toBe(
      '{"access_token":"tok"}',
    );
    expect(
      kv.values.get(buildWorkspaceSecretKey("workspace-1", "provider:openai-oauth")),
    ).not.toContain("tok");
    await expect(writer.listMetadata("workspace-1")).resolves.toEqual([
      { name: "provider:openai-oauth", updated_at: "2026-06-28T00:00:00.000Z" },
    ]);
  });

  it("returns null when a workspace or named secret is missing", async () => {
    const kv = new MemoryKV();
    const kek = importRawKey(new Uint8Array(32).fill(3));
    const writer = new KVWorkspaceSecretsWriter(kv as unknown as KVNamespace, kek);
    const store = new KVWorkspaceSecretsStore(kv as unknown as KVNamespace, kek);

    await expect(store.get("workspace-1", "missing")).resolves.toBeNull();
    await writer.ensureWorkspaceDek("workspace-1");
    await expect(store.get("workspace-1", "missing")).resolves.toBeNull();
  });

  it("detects corrupt secret records", async () => {
    const kv = new MemoryKV();
    const kek = importRawKey(new Uint8Array(32).fill(3));
    const writer = new KVWorkspaceSecretsWriter(kv as unknown as KVNamespace, kek);
    const store = new KVWorkspaceSecretsStore(kv as unknown as KVNamespace, kek);

    await writer.ensureWorkspaceDek("workspace-1");
    await writer.set("workspace-1", "provider", "secret");
    kv.values.set(
      buildWorkspaceSecretKey("workspace-1", "provider"),
      JSON.stringify({
        ciphertext: packB64(new Uint8Array([1, 2, 3])),
        dek_version: 1,
        updated_at: "2026-06-28T00:00:00.000Z",
      }),
    );

    await expect(store.get("workspace-1", "provider")).rejects.toMatchObject({
      name: "SecretsError",
      code: "secret_corrupt",
    } satisfies Partial<SecretsError>);
  });
});
