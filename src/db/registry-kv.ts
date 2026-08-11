import type { RegistryDatabase } from "./registry-do";
import { REGISTRY_DO_ID } from "./registry-d1";

/**
 * A KVNamespace-shaped facade over the celld RegistryDatabase Durable Object.
 *
 * Cloudflare keeps the real `SECRETS_KV` binding; celld has no KV, so
 * `secretsBinding` hands every consumer a `RegistryKV` instead. It implements
 * the KV surface the app actually touches — `get`/`put`/`delete`/`list` — by
 * translating each call into an RPC over the singleton `RegistryDatabase`,
 * which stores the values verbatim (they are already AES-GCM ciphertext) in a
 * DO-private `__celld_kv` table.
 *
 * Options that would change KV semantics are rejected, not ignored: a silently
 * dropped `expirationTtl`/`expiration`/`metadata` on `put`, a silently dropped
 * `cacheTtl` on `get`, or `getWithMetadata` would make celld behave differently
 * from Cloudflare in exactly the ways that matter for secrets.
 */

/** KV lists keys in lexicographic byte order; the default/maximum page size
 *  mirrors real KV (1000). */
const KV_LIST_DEFAULT_LIMIT = 1000;

/** The `get` option shapes the facade accepts (all of KV's except batch). */
type RegistryKvGetOptions =
  | Partial<KVNamespaceGetOptions<undefined>>
  | KVNamespaceGetOptions<"text">
  | KVNamespaceGetOptions<"json">
  | KVNamespaceGetOptions<"arrayBuffer">
  | KVNamespaceGetOptions<"stream">;

export class RegistryKV implements KVNamespace {
  private readonly stub: DurableObjectStub<RegistryDatabase>;

  constructor(namespace: DurableObjectNamespace<RegistryDatabase>) {
    this.stub = namespace.get(namespace.idFromName(REGISTRY_DO_ID));
  }

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
    const value = await this.stub.kvGet(key);
    if (value === null) return null;
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
    const page = await this.stub.kvList({
      prefix: options?.prefix ?? "",
      limit: options?.limit ?? KV_LIST_DEFAULT_LIMIT,
      cursor: options?.cursor ?? null,
    });
    const keys = page.keys as KVNamespaceListKey<Metadata, string>[];
    if (!page.list_complete) {
      return {
        keys,
        list_complete: false,
        cursor: page.cursor as string,
        cacheStatus: page.cacheStatus,
      };
    }
    return { keys, list_complete: true, cacheStatus: page.cacheStatus };
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
    await this.stub.kvPut(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.stub.kvDelete(key);
  }

  async getWithMetadata(_key: string | string[], _options?: unknown): Promise<never> {
    throw new Error("RegistryKV: getWithMetadata() is not supported on celld");
  }
}
