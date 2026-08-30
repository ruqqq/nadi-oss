import { describe, expect, it } from "vitest";
import { importRawKey, packB64 } from "../../../src/secrets/aead";
import { SecretsError } from "../../../src/secrets/errors";
import {
  buildWorkspaceSecretKey,
  buildWorkspaceSecretIndexKey,
  buildWorkspaceSecretPrefix,
  parseWorkspaceSecretIndex,
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

  // Mirrors celld: a list prefix over 49 bytes (each `_`/`%`/`\` counting two,
  // because celld escapes it into a LIKE pattern) is rejected by SQLite. A mock
  // that accepts any prefix is why this shipped broken. Nothing in src/ should
  // call this at all once the index lands.
  async list(input?: { prefix?: string }): Promise<KVNamespaceListResult<unknown>> {
    const prefix = input?.prefix ?? "";
    let cost = 0;
    for (const char of prefix) {
      cost += char === "_" || char === "%" || char === "\\" ? 2 : 1;
    }
    if (cost > 49) {
      throw new Error("SQL error: step SQL cursor: LIKE or GLOB pattern too complex");
    }
    return {
      keys: [...this.values.keys()]
        .filter((n) => n.startsWith(prefix))
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

describe("workspace secret index records", () => {
  it("builds an index key that is not itself under the secrets prefix", () => {
    const key = buildWorkspaceSecretIndexKey("ws_1");
    expect(key).toBe("workspaces/ws_1/secret-index");
    expect(key.startsWith(buildWorkspaceSecretPrefix("ws_1"))).toBe(false);
  });

  it("parses a well-formed index", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: { EXA_API_KEY: { updated_at: "2026-08-30T00:00:00.000Z" } },
    });
    expect(parseWorkspaceSecretIndex(raw, "ws_1")).toEqual({
      version: 1,
      entries: { EXA_API_KEY: { updated_at: "2026-08-30T00:00:00.000Z" } },
    });
  });

  it("rejects a malformed index rather than reading it as empty", () => {
    expect(() => parseWorkspaceSecretIndex("{]", "ws_1")).toThrow(/invalid workspace secret index/);
    expect(() => parseWorkspaceSecretIndex('{"version":2,"entries":{}}', "ws_1")).toThrow(
      /invalid workspace secret index/,
    );
    expect(() => parseWorkspaceSecretIndex('{"version":1}', "ws_1")).toThrow(
      /invalid workspace secret index/,
    );
    expect(() => parseWorkspaceSecretIndex('{"version":1,"entries":{"A":{}}}', "ws_1")).toThrow(
      /invalid workspace secret index/,
    );
  });
});

describe("workspace secret listing without a KV prefix scan", () => {
  const ws = "ws_cf8e3c5c-8a9a-4904-a32b-d68e8e5f28d0";

  function writerFor(kv: MemoryKV) {
    return new KVWorkspaceSecretsWriter(
      kv as unknown as KVNamespace,
      importRawKey(new Uint8Array(32).fill(3)),
    );
  }

  it("lists secrets for a real-length workspace id", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "EXA_API_KEY", "v1", { updatedAt: "2026-08-30T01:00:00.000Z" });
    await writer.set(ws, "provider:opencode-go", "v2", { updatedAt: "2026-08-30T02:00:00.000Z" });

    await expect(writer.listMetadata(ws)).resolves.toEqual([
      { name: "EXA_API_KEY", updated_at: "2026-08-30T01:00:00.000Z" },
      { name: "provider:opencode-go", updated_at: "2026-08-30T02:00:00.000Z" },
    ]);
  });

  it("never calls list", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);
    const listed: string[] = [];
    const original = kv.list.bind(kv);
    kv.list = async (input?: { prefix?: string }) => {
      listed.push(input?.prefix ?? "");
      return original(input);
    };

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "A", "v", { updatedAt: "2026-08-30T01:00:00.000Z" });
    await writer.listMetadata(ws);
    await writer.delete(ws, "A");
    await writer.listMetadata(ws);

    expect(listed).toEqual([]);
  });

  it("returns an empty list for a workspace that has never held a secret", async () => {
    const kv = new MemoryKV();
    await expect(writerFor(kv).listMetadata(ws)).resolves.toEqual([]);
  });

  it("fails loudly when a workspace has a DEK but no index", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "LEGACY", "v", { updatedAt: "2026-08-30T03:00:00.000Z" });
    // The pre-index world: DEK and values exist, no index does.
    kv.values.delete(buildWorkspaceSecretIndexKey(ws));

    await expect(writer.listMetadata(ws)).rejects.toMatchObject({
      name: "SecretsError",
      code: "index_missing",
    });
  });

  it("refuses to write rather than erase an un-backfilled workspace", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "OLD", "v", { updatedAt: "2026-08-30T01:00:00.000Z" });
    kv.values.delete(buildWorkspaceSecretIndexKey(ws));

    await expect(writer.set(ws, "NEW", "v")).rejects.toMatchObject({ code: "index_missing" });
    // And the pre-existing secret is untouched.
    expect(kv.values.has(buildWorkspaceSecretKey(ws, "OLD"))).toBe(true);
  });

  it("drops a deleted secret from the listing", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "A", "v", { updatedAt: "2026-08-30T01:00:00.000Z" });
    await writer.set(ws, "B", "v", { updatedAt: "2026-08-30T02:00:00.000Z" });
    await expect(writer.delete(ws, "A")).resolves.toBe(true);

    await expect(writer.listMetadata(ws)).resolves.toEqual([
      { name: "B", updated_at: "2026-08-30T02:00:00.000Z" },
    ]);
  });

  it("lets a ghost index entry be deleted even though its value is gone", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "GHOST", "v", { updatedAt: "2026-08-30T04:00:00.000Z" });
    // A delete that crashed between removing the value and updating the index.
    kv.values.delete(buildWorkspaceSecretKey(ws, "GHOST"));

    // `false` reports that no value was destroyed; the index is repaired anyway,
    // so the ghost is not permanent.
    await expect(writer.delete(ws, "GHOST")).resolves.toBe(false);
    await expect(writer.listMetadata(ws)).resolves.toEqual([]);
  });
});
