/**
 * A KVNamespace-shaped facade over a table in the registry database.
 *
 * Cloudflare keeps the real `SECRETS_KV` binding. celld has no KV and it is
 * explicitly not on celld's roadmap — KV is a globally-replicated eventually
 * consistent cache, which is a different system from a cell — so
 * `secretsBinding` hands every consumer a `RegistryKV` instead. It implements
 * the KV surface the app actually touches (`get`/`put`/`delete`/`list`) over
 * the `celld_kv` table in the registry D1 database, storing values verbatim
 * (they are already AES-GCM ciphertext).
 *
 * Before celld v0.3.0 this ran over RPC to a `RegistryDatabase` Durable Object,
 * because celld had no D1 either. It now talks to a real `d1_databases`
 * binding, which is the same object Cloudflare's registry code uses — so this
 * facade is the ONLY remaining celld-shaped seam in the registry.
 *
 * Options that would change KV semantics are rejected, not ignored: a silently
 * dropped `expirationTtl`/`expiration`/`metadata` on `put`, a silently dropped
 * `cacheTtl` on `get`, or `getWithMetadata` would make celld behave differently
 * from Cloudflare in exactly the ways that matter for secrets.
 */

/** KV lists keys in lexicographic byte order; the default/maximum page size
 *  mirrors real KV (1000). */
const KV_LIST_DEFAULT_LIMIT = 1000;

/** U+10FFFF — the largest valid UTF-8 code point. `prefix + this` is the
 *  bytewise upper bound for "keys starting with `prefix`" under SQLite's
 *  BINARY collation. Edge note: a key whose first code point after `prefix`
 *  is exactly U+10FFFF sorts at the bound and is excluded — unreachable for
 *  secrets keys (ASCII `workspaces/<id>/secrets/<name>`), so the cheaper
 *  range bound wins over a LIKE-based predicate (LIKE is ASCII-case-insensitive
 *  in SQLite, which would break key ordering). */
const KV_LIST_PREFIX_CEILING = "\u{10FFFF}";

/** The `get` option shapes the facade accepts (all of KV's except batch). */
type RegistryKvGetOptions =
  | Partial<KVNamespaceGetOptions<undefined>>
  | KVNamespaceGetOptions<"text">
  | KVNamespaceGetOptions<"json">
  | KVNamespaceGetOptions<"arrayBuffer">
  | KVNamespaceGetOptions<"stream">;

function encodeKvCursor(prefix: string, lastKey: string): string {
  const json = JSON.stringify({ p: prefix, k: lastKey });
  let binary = "";
  for (const byte of new TextEncoder().encode(json)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeKvCursor(cursor: string): { p: string; k: string } | null {
  try {
    const binary = atob(cursor);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as { p: string; k: string };
  } catch {
    return null;
  }
}

export class RegistryKV implements KVNamespace {
  constructor(private readonly db: D1Database) {}

  get(key: string, options?: Partial<KVNamespaceGetOptions<undefined>>): Promise<string | null>;
  get(key: string, type: "text"): Promise<string | null>;
  get<ExpectedValue = unknown>(key: string, type: "json"): Promise<ExpectedValue | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  get(key: string, type: "stream"): Promise<ReadableStream | null>;
  get(key: string, options?: KVNamespaceGetOptions<"text">): Promise<string | null>;
  get<ExpectedValue = unknown>(
    key: string,
    options?: KVNamespaceGetOptions<"json">,
  ): Promise<ExpectedValue | null>;
  get(key: string, options?: KVNamespaceGetOptions<"arrayBuffer">): Promise<ArrayBuffer | null>;
  get(key: string, options?: KVNamespaceGetOptions<"stream">): Promise<ReadableStream | null>;
  get(key: string[], type: "text"): Promise<Map<string, string | null>>;
  get<ExpectedValue = unknown>(
    key: string[],
    type: "json",
  ): Promise<Map<string, ExpectedValue | null>>;
  get(
    key: string[],
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Promise<Map<string, string | null>>;
  get(key: string[], options?: KVNamespaceGetOptions<"text">): Promise<Map<string, string | null>>;
  get<ExpectedValue = unknown>(
    key: string[],
    options?: KVNamespaceGetOptions<"json">,
  ): Promise<Map<string, ExpectedValue | null>>;
  async get(
    key: string | string[],
    typeOrOptions?: string | RegistryKvGetOptions,
  ): Promise<unknown> {
    if (Array.isArray(key)) {
      throw new Error("RegistryKV: batch get() is not supported on celld");
    }
    const options = typeof typeOrOptions === "string" ? undefined : (typeOrOptions ?? undefined);
    const type = typeof typeOrOptions === "string" ? typeOrOptions : (options?.type ?? "text");
    if (options?.cacheTtl !== undefined) {
      throw new Error(
        "RegistryKV: get() cacheTtl is not supported on celld — refusing to silently skip it",
      );
    }
    if (type === "stream") {
      throw new Error('RegistryKV: get() type "stream" is not supported on celld');
    }
    const value = await this.db
      .prepare("SELECT value FROM celld_kv WHERE key = ?")
      .bind(key)
      .first<string>("value");
    if (value === null || value === undefined) return null;
    switch (type) {
      case "text":
        return value;
      case "json":
        return JSON.parse(value);
      case "arrayBuffer":
        return new TextEncoder().encode(value).buffer;
      default:
        throw new Error(`RegistryKV: get() type ${JSON.stringify(type)} is not supported`);
    }
  }

  async list<Metadata = unknown>(
    options?: KVNamespaceListOptions,
  ): Promise<KVNamespaceListResult<Metadata, string>> {
    const prefix = options?.prefix ?? "";
    const limit = Math.min(
      Math.max(options?.limit ?? KV_LIST_DEFAULT_LIMIT, 1),
      KV_LIST_DEFAULT_LIMIT,
    );
    const cursor = options?.cursor ?? null;
    const after = cursor === null ? null : decodeKvCursor(cursor);
    if (cursor !== null && after === null) {
      throw new Error("RegistryKV list: malformed cursor");
    }
    if (after !== null && after.p !== prefix) {
      throw new Error(
        "RegistryKV list: cursor was issued for a different prefix; refusing to apply it",
      );
    }
    const params: unknown[] = [prefix, prefix + KV_LIST_PREFIX_CEILING];
    let sql = "SELECT key FROM celld_kv WHERE key >= ? AND key < ?";
    if (after) {
      sql += " AND key > ?";
      params.push(after.k);
    }
    // Fetch one row past the page so `list_complete` reflects the namespace,
    // not just the page (a facade that always says complete silently
    // truncates for callers that loop on the cursor).
    sql += " ORDER BY key LIMIT ?";
    params.push(limit + 1);

    const rows = await this.db
      .prepare(sql)
      .bind(...params)
      .all<{ key: string }>();
    const found = rows.results.map((row) => row.key);
    const page = found.slice(0, limit);
    const hasMore = found.length > limit;
    const keys = page.map((name) => ({ name })) as KVNamespaceListKey<Metadata, string>[];
    if (hasMore) {
      return {
        keys,
        list_complete: false,
        cursor: encodeKvCursor(prefix, page[page.length - 1]!),
        cacheStatus: null,
      };
    }
    return { keys, list_complete: true, cacheStatus: null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Promise<void> {
    if (
      options &&
      (options.expiration !== undefined ||
        options.expirationTtl !== undefined ||
        options.metadata !== undefined)
    ) {
      throw new Error(
        "RegistryKV: put() expiration/expirationTtl/metadata are not supported on celld — " +
          "refusing to silently drop a TTL; remove the option or keep using real KV",
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        "RegistryKV: put() only supports string values on celld; binary and stream values are not supported",
      );
    }
    // No value-size check: real KV rejects values over 25 MiB, but the values
    // stored here are AES-GCM ciphertext of secrets, far under that limit.
    await this.db
      .prepare(
        "INSERT INTO celld_kv (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .bind(key, value)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM celld_kv WHERE key = ?").bind(key).run();
  }

  async getWithMetadata(_key: string | string[], _options?: unknown): Promise<never> {
    throw new Error("RegistryKV: getWithMetadata() is not supported on celld");
  }
}
