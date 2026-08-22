import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RegistryKV } from "../../src/db/registry-kv";
import type { Env } from "../../src/env";
import {
  clearMcpOAuthCredentials,
  getMcpOAuthTokens,
  putMcpOAuthTokens,
} from "../../src/mcp/oauth-store";
import { createWorkspaceSecretsServices, secretsBinding } from "../../src/secrets";
import { buildWorkspaceSecretKey, buildWorkspaceSecretPrefix } from "../../src/secrets/kv-records";

// TEST-ONLY: REGISTRY_DO is bound in the pool (see vitest.config.ts) so the
// celld KV facade can be exercised on the Cloudflare side.
const poolEnv = env as unknown as Env;

/** An env shaped like celld's: no SECRETS_KV, REGISTRY_DO present. */
function celldEnv(overrides?: Partial<Env>): Env {
  return {
    ...poolEnv,
    SECRETS_KV: undefined,
    REGISTRY_DO: poolEnv.REGISTRY_DO,
    NADI_PLATFORM: "celld",
    ...overrides,
  } as unknown as Env;
}

/** A KVNamespace-shaped facade over the singleton RegistryDatabase DO. */
function freshKv(): KVNamespace {
  return new RegistryKV(poolEnv.REGISTRY_DO!);
}

describe("secretsBinding", () => {
  it("returns the real KV binding when SECRETS_KV exists", () => {
    expect(secretsBinding(poolEnv)).toBe(poolEnv.SECRETS_KV);
  });

  it("returns a RegistryKV facade when SECRETS_KV is absent", () => {
    const binding = secretsBinding(celldEnv());
    expect(binding).toBeInstanceOf(RegistryKV);
    const services = createWorkspaceSecretsServices(celldEnv());
    expect(services.store).toBeDefined();
    expect(services.writer).toBeDefined();
  });

  it("fails loudly when neither binding exists", () => {
    const broken = { ...poolEnv, SECRETS_KV: undefined, REGISTRY_DO: undefined } as unknown as Env;
    expect(() => secretsBinding(broken)).toThrow(/SECRETS_KV nor REGISTRY_DO/);
  });
});

describe("RegistryKV facade", () => {
  it("returns null for a missing key, not undefined", async () => {
    const kv = freshKv();
    expect(await kv.get("workspaces/facade-missing/secrets/nope")).toBeNull();
  });

  it("put/get round trips, and put overwrites", async () => {
    const kv = freshKv();
    const key = "workspaces/facade-rw/secrets/roundtrip";
    await kv.put(key, "first value");
    expect(await kv.get(key)).toBe("first value");
    await kv.put(key, "second value");
    expect(await kv.get(key)).toBe("second value");
  });

  it("delete removes a key and tolerates missing keys", async () => {
    const kv = freshKv();
    const key = "workspaces/facade-del/secrets/gone";
    await kv.put(key, "v");
    await expect(kv.delete(key)).resolves.toBeUndefined();
    expect(await kv.get(key)).toBeNull();
    await expect(kv.delete("workspaces/facade-del/secrets/never-existed")).resolves.toBeUndefined();
  });

  it("unicode and long values survive the round trip", async () => {
    const kv = freshKv();
    const key = "workspaces/facade-uni/secrets/snowman";
    const long = "x".repeat(64 * 1024);
    const unicode = "héllo wörld — 🎉 Δοκιμή 🎈 \u{1F600} and a trailing é";
    await kv.put(key, unicode);
    expect(await kv.get(key)).toBe(unicode);
    await kv.put("workspaces/facade-uni/secrets/long", long);
    expect(await kv.get("workspaces/facade-uni/secrets/long")).toBe(long);
  });

  it("get type json parses and arrayBuffer returns UTF-8 bytes", async () => {
    const kv = freshKv();
    const key = "workspaces/facade-types/secrets/doc";
    await kv.put(key, JSON.stringify({ hello: "world" }));
    expect(await kv.get(key, "json")).toEqual({ hello: "world" });
    const bytes = await kv.get(key, "arrayBuffer");
    expect(new TextDecoder().decode(bytes!)).toBe(JSON.stringify({ hello: "world" }));
  });

  it("rejects get paths the celld store does not implement", async () => {
    const kv = freshKv();
    const key = "workspaces/facade-reject/secrets/x";
    await kv.put(key, "v");
    await expect(kv.get(key, "stream")).rejects.toThrow(/not supported/);
    await expect(kv.get([key], "text")).rejects.toThrow(/not supported/);
    await expect(kv.get(key, { cacheTtl: 30 })).rejects.toThrow(/cacheTtl/);
    await expect(kv.getWithMetadata(key)).rejects.toThrow(/getWithMetadata/);
  });

  it("rejects put options that would change KV semantics", async () => {
    const kv = freshKv();
    const key = "workspaces/facade-options/secrets/x";
    await expect(kv.put(key, "v", { expirationTtl: 60 })).rejects.toThrow(/expirationTtl/);
    await expect(kv.put(key, "v", { expiration: 1_800_000_000 })).rejects.toThrow(/expiration/);
    await expect(kv.put(key, "v", { metadata: { owner: "me" } })).rejects.toThrow(/metadata/);
    expect(await kv.get(key)).toBeNull();
  });

  it("rejects non-string put values", async () => {
    const kv = freshKv();
    const key = "workspaces/facade-binary/secrets/x";
    await expect(kv.put(key, new TextEncoder().encode("bytes"))).rejects.toThrow(
      /only supports string/,
    );
    await expect(kv.put(key, new ReadableStream())).rejects.toThrow(/only supports string/);
    expect(await kv.get(key)).toBeNull();
  });
});

describe("RegistryKV list", () => {
  const wsA = "list-aaa";
  const wsB = "list-bbb";
  const prefixA = buildWorkspaceSecretPrefix(wsA);
  const prefixB = buildWorkspaceSecretPrefix(wsB);
  // 12 names that sort identically numerically and lexicographically.
  const namesA = Array.from({ length: 12 }, (_, i) => `s-${String(i).padStart(2, "0")}`);

  it("lists every key when no prefix is given", async () => {
    const kv = freshKv();
    const g1 = `${buildWorkspaceSecretPrefix("list-global")}alpha`;
    const g2 = `${buildWorkspaceSecretPrefix("list-global")}omega`;
    await kv.put(g1, "v1");
    await kv.put(g2, "v2");

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv.list({ limit: 100, cursor: cursor ?? null });
      seen.push(...page.keys.map((key) => key.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);

    expect(seen).toContain(g1);
    expect(seen).toContain(g2);
    expect(seen.indexOf(g1)).toBeLessThan(seen.indexOf(g2));
    expect(new Set(seen).size).toBe(seen.length);
    // No-prefix means the whole namespace, so keys from every prefix (not just
    // `workspaces/`) must flow through here; later tests add non-workspace
    // keys, so this test only pins containment, order, and uniqueness.
  });

  it("paginates with list_complete and cursor, in key order, isolated by prefix", async () => {
    const kv = freshKv();
    for (const name of namesA) await kv.put(buildWorkspaceSecretKey(wsA, name), "v");
    await kv.put(buildWorkspaceSecretKey(wsB, "x"), "v");
    await kv.put(buildWorkspaceSecretKey(wsB, "y"), "v");

    // The loop a pagination-aware consumer (e.g. a writer that pages until
    // complete) runs: every key must be seen exactly once, in order, with no
    // keys leaking in from the other workspace. A facade that reports
    // list_complete too early silently truncates here.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await kv.list({ prefix: prefixA, limit: 5, cursor: cursor ?? null });
      pages += 1;
      expect(page.keys.length).toBeLessThanOrEqual(5);
      seen.push(...page.keys.map((key) => key.name));
      if (page.list_complete) {
        expect(page).not.toHaveProperty("cursor");
        cursor = undefined;
      } else {
        expect(page.cursor).toBeTypeOf("string");
        cursor = page.cursor;
      }
    } while (cursor !== undefined);

    expect(pages).toBe(3); // 12 keys at 5 per page -> 5 + 5 + 2
    expect(seen).toEqual(namesA.map((name) => buildWorkspaceSecretKey(wsA, name)));
    expect(seen).toHaveLength(12);

    // Prefix isolation in the other direction, and a one-page list.
    const bPage = await kv.list({ prefix: prefixB });
    expect(bPage.keys.map((key) => key.name)).toEqual([
      buildWorkspaceSecretKey(wsB, "x"),
      buildWorkspaceSecretKey(wsB, "y"),
    ]);
    expect(bPage.list_complete).toBe(true);
  });

  it("returns an empty page for a fresh prefix", async () => {
    const kv = freshKv();
    const page = await kv.list({ prefix: buildWorkspaceSecretPrefix("list-empty") });
    expect(page.keys).toEqual([]);
    expect(page.list_complete).toBe(true);
    expect(page).not.toHaveProperty("cursor");
  });

  it("refuses to apply a cursor to a different prefix", async () => {
    const kv = freshKv();
    const keys = ["a", "b", "c"];
    for (const name of keys) await kv.put(buildWorkspaceSecretKey(wsA, name), "v");
    const page = await kv.list({ prefix: prefixA, limit: 1 });
    expect(page.list_complete).toBe(false);
    if (page.list_complete) throw new Error("expected an incomplete page");
    await expect(kv.list({ prefix: prefixB, limit: 1, cursor: page.cursor })).rejects.toThrow(
      /different prefix/,
    );
  });

  it("defaults to the same 1000-key page size as real KV", async () => {
    const kv = freshKv();
    const prefix = buildWorkspaceSecretPrefix("list-big");
    for (let i = 0; i < 1001; i++) {
      await kv.put(`${prefix}${String(i).padStart(4, "0")}`, "v");
    }

    const first = await kv.list({ prefix });
    expect(first.keys).toHaveLength(1000);
    expect(first.keys[0]!.name).toBe(`${prefix}0000`);
    expect(first.keys[999]!.name).toBe(`${prefix}0999`);
    expect(first.list_complete).toBe(false);
    if (first.list_complete) throw new Error("expected an incomplete page");
    expect(first.cursor).toBeTypeOf("string");

    const second = await kv.list({ prefix, cursor: first.cursor });
    expect(second.keys.map((key) => key.name)).toEqual([`${prefix}1000`]);
    expect(second.list_complete).toBe(true);
  }, 20_000);
});

describe("workspace secrets through the facade", () => {
  it("round-trips an encrypted secret for the real 'default' workspace", async () => {
    const env_ = celldEnv();
    const { store, writer } = createWorkspaceSecretsServices(env_);
    const name = "provider:openai";
    const value = "sk-proj-9f8e7d6c5b4a3f2e1d0c";
    await writer.ensureWorkspaceDek("default");
    await writer.set("default", name, value);
    expect(await store.get("default", name)).toBe(value);

    const replacement = "sk-proj-rotated-value";
    await writer.set("default", name, replacement);
    expect(await store.get("default", name)).toBe(replacement);
    expect(await writer.getMetadata("default", name)).toEqual({
      name,
      updated_at: expect.any(String),
    });

    expect(await writer.delete("default", name)).toBe(true);
    expect(await store.get("default", name)).toBeNull();
  });

  it("lists the workspace's secrets through the real writer path", async () => {
    const env_ = celldEnv();
    const { writer } = createWorkspaceSecretsServices(env_);
    const ws = "writer-list";
    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "openai", "sk-1");
    await writer.set(ws, "anthropic", "sk-2");
    const metadata = await writer.listMetadata(ws);
    expect(metadata.map((item) => item.name)).toEqual(["anthropic", "openai"]);
    expect(metadata[0]!.updated_at).toEqual(expect.any(String));
  });

  it("round-trips MCP OAuth tokens and clears them", async () => {
    const env_ = celldEnv();
    const ws = "kv-oauth";
    const server = "svr-1";
    await putMcpOAuthTokens(env_, ws, server, {
      access_token: "at-1",
      token_type: "bearer",
      refresh_token: "rt-1",
    });
    expect(await getMcpOAuthTokens(env_, ws, server)).toEqual({
      access_token: "at-1",
      token_type: "bearer",
      refresh_token: "rt-1",
    });

    await clearMcpOAuthCredentials(env_, ws, server);
    expect(await getMcpOAuthTokens(env_, ws, server)).toBeUndefined();
  });
});

describe("parity with real KV", () => {
  it("behaves identically for the same workload", async () => {
    const real = poolEnv.SECRETS_KV;
    const facade = freshKv();
    const keys = ["parity/secrets/alpha", "parity/secrets/beta", "parity/secrets/gamma"];

    for (const key of keys) {
      await real.put(key, "v");
      await facade.put(key, "v");
    }
    const [alpha, beta] = keys as [string, string, string];
    expect(await facade.get(beta)).toBe(await real.get(beta));
    expect(await facade.get("parity/secrets/missing")).toBeNull();
    expect(await real.get("parity/secrets/missing")).toBeNull();

    // Page both namespaces the same way and compare the observable contract.
    const realSeen: string[] = [];
    const facadeSeen: string[] = [];
    const stores: Array<[KVNamespace, string[]]> = [
      [real, realSeen],
      [facade, facadeSeen],
    ];
    for (const [kv, seen] of stores) {
      let cursor: string | null = null;
      for (;;) {
        const page: KVNamespaceListResult<unknown, string> = await kv.list({
          prefix: "parity/secrets/",
          limit: 2,
          cursor,
        });
        seen.push(...page.keys.map((key) => key.name));
        if (page.list_complete) break;
        cursor = page.cursor;
      }
    }
    expect(facadeSeen).toEqual(realSeen);
    expect(facadeSeen).toEqual(keys);

    await real.delete(alpha);
    await facade.delete(alpha);
    expect(await facade.get(alpha)).toBeNull();
    expect(await real.get(alpha)).toBeNull();
  });
});
