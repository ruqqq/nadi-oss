import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WEB_MAX_TOTAL_DOCUMENT_BYTES, WebDocumentStore } from "../../src/web/document-store";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";

/**
 * `DurableObject.ctx` is `protected` on the base class (see
 * @cloudflare/workers-types), so it isn't reachable from outside the agent
 * class under strict TS. Runtime access is fine (it's a plain property) —
 * this narrow cast is scoped to this test file only, not production code
 * (mirrors the pattern in test/integration/compute-thread-store.test.ts).
 */
function storageOf(instance: ThinkThreadAgent): DurableObjectStorage {
  return (instance as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

async function withStore<T>(fn: (store: WebDocumentStore) => T): Promise<T> {
  const id = env.THINK_THREAD_AGENT.idFromName(`webdoc-store-test-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    const store = new WebDocumentStore(storageOf(instance));
    store.migrate();
    return fn(store);
  });
}

describe("WebDocumentStore", () => {
  it("writes a document and reads a bounded line range", async () => {
    const result = await withStore((store) => {
      const meta = store.writeDocument({
        url: "https://a.com",
        finalUrl: "https://a.com",
        contentType: "text/markdown",
        title: "T",
        body: ["alpha", "bravo needle", "charlie", "delta needle"].join("\n") + "\n",
        truncated: false,
        via: "direct",
      });
      const read = store.readDocument(meta.documentId, { startLine: 2, endLine: 2 });
      const grep = store.grepDocument(meta.documentId, { pattern: "needle" });
      return { meta, read, grep };
    });
    expect(result.meta.lineCount).toBe(4);
    expect(result.read.text).toContain("bravo needle");
    expect(result.read.text).not.toContain("charlie");
    expect(result.grep.matches).toHaveLength(2);
  });

  it("round-trips a search cache entry", async () => {
    const out = await withStore((store) => {
      const id = store.putSearch("q", [{ title: "A", url: "https://a.com", snippet: "s" }]);
      return store.getSearch(id);
    });
    expect(out?.results[0]?.url).toBe("https://a.com");
  });

  it("evicts the oldest documents once total bytes exceed the cap", async () => {
    const id = env.THINK_THREAD_AGENT.idFromName(`webdoc-store-test-${crypto.randomUUID()}`);
    const stub = env.THINK_THREAD_AGENT.get(id);
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const storage = storageOf(instance);
      const store = new WebDocumentStore(storage);
      store.migrate();

      // Each document body must stay well under the SQLite per-value size
      // limit (a single ~3MB string trips SQLITE_TOOBIG), so cross the 8MB
      // total-bytes cap with several ~900KB documents instead — count stays
      // under WEB_MAX_DOCUMENTS (20) so only the byte cap is exercised.
      const bodyOf = (label: string) => `${label}:` + "x".repeat(900_000);
      const first = store.writeDocument({
        url: "https://a.com/1",
        finalUrl: "https://a.com/1",
        contentType: "text/plain",
        body: bodyOf("first"),
        truncated: false,
        via: "direct",
      });
      for (let i = 2; i <= 9; i++) {
        store.writeDocument({
          url: `https://a.com/${i}`,
          finalUrl: `https://a.com/${i}`,
          contentType: "text/plain",
          body: bodyOf(`mid${i}`),
          truncated: false,
          via: "direct",
        });
      }
      const third = store.writeDocument({
        url: "https://a.com/last",
        finalUrl: "https://a.com/last",
        contentType: "text/plain",
        body: bodyOf("third"),
        truncated: false,
        via: "direct",
      });

      const totalBytes = storage.sql
        .exec<{ total: number }>("SELECT COALESCE(SUM(byte_size),0) AS total FROM web_documents")
        .toArray()[0]!.total;

      return {
        totalBytes,
        oldestMeta: store.getDocumentMeta(first.documentId),
        newestRead: store.readDocument(third.documentId, { startLine: 1, endLine: 1 }),
      };
    });

    // Three ~3MB bodies sum to ~9MB, over the 8MB cap, so the oldest
    // (first) document must have been evicted while the newest is intact.
    expect(result.totalBytes).toBeLessThanOrEqual(WEB_MAX_TOTAL_DOCUMENT_BYTES);
    expect(result.oldestMeta).toBeNull();
    expect(result.newestRead.text).toContain("third:");
  });
});
