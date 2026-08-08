import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { buildWebToolDefs } from "../../src/agent/web-tools";
import { WebDocumentStore } from "../../src/web/document-store";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { WebFetchProvider, WebSearchProvider } from "../../src/web/types";

/**
 * `DurableObject.ctx` is `protected` on the base class (see
 * @cloudflare/workers-types), so it isn't reachable from outside the agent
 * class under strict TS. Runtime access is fine (it's a plain property) —
 * this narrow cast is scoped to this test file only, not production code
 * (mirrors the pattern in test/integration/web-document-store.integration.test.ts
 * and test/integration/compute-thread-store.test.ts).
 */
function storageOf(instance: ThinkThreadAgent): DurableObjectStorage {
  return (instance as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

const fetcher: WebFetchProvider = {
  fetch: vi.fn().mockResolvedValue({
    url: "https://a.com",
    finalUrl: "https://a.com",
    contentType: "text/markdown",
    title: "Doc",
    content: Array.from({ length: 100 }, (_, i) => `line ${i} needle`).join("\n") + "\n",
    truncated: false,
    via: "direct",
  }),
};
const searcher: WebSearchProvider = {
  search: vi.fn().mockResolvedValue({
    results: Array.from({ length: 12 }, (_, i) => ({
      title: `t${i}`,
      url: `https://a.com/${i}`,
      snippet: "snip",
    })),
  }),
};

async function withTools<T>(
  fn: (tools: ReturnType<typeof buildWebToolDefs>) => Promise<T>,
): Promise<T> {
  const id = env.THINK_THREAD_AGENT.idFromName(`web-tools-test-${crypto.randomUUID()}`);
  const stub = env.THINK_THREAD_AGENT.get(id);
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    const store = new WebDocumentStore(storageOf(instance));
    store.migrate();
    const tools = buildWebToolDefs(
      () => store,
      () => fetcher,
      () => searcher,
    );
    return fn(tools);
  });
}

describe("web tools end to end", () => {
  it("web_fetch stores a large body; read + grep page through it", async () => {
    const out = await withTools(async (tools) => {
      const fetched = (await tools.web_fetch!.execute!({ url: "https://a.com" }, {} as never)) as {
        documentId: string;
        lineCount: number;
        preview: string;
      };
      const read = await tools.web_fetch_read!.execute!(
        { documentId: fetched.documentId, startLine: 5, endLine: 6 },
        {} as never,
      );
      const grep = await tools.web_fetch_grep!.execute!(
        { documentId: fetched.documentId, pattern: "needle", maxMatches: 3 },
        {} as never,
      );
      return { fetched, read, grep };
    });
    expect(out.fetched.lineCount).toBe(100);
    expect(out.fetched.preview).toContain("line 0 needle");
    expect((out.read as { text: string }).text).toContain("line 4 needle");
    expect((out.grep as { matches: unknown[]; limited: boolean }).matches).toHaveLength(3);
    expect((out.grep as { limited: boolean }).limited).toBe(true);
  });

  it("web_search returns a first page and pages via the cursor without re-searching", async () => {
    const out = await withTools(async (tools) => {
      const first = (await tools.web_search!.execute!(
        { query: "hi", pageSize: 5 },
        {} as never,
      )) as {
        results: unknown[];
        nextCursor?: string;
        totalAvailable: number;
      };
      const second = (await tools.web_search!.execute!(
        { query: "hi", cursor: first.nextCursor },
        {} as never,
      )) as { results: unknown[] };
      return { first, second };
    });
    expect(out.first.results).toHaveLength(5);
    expect(out.first.totalAvailable).toBe(12);
    expect(out.second.results).toHaveLength(5);
    // One page 0-4, next 5-9: searcher called exactly once (batch cached).
    expect(searcher.search).toHaveBeenCalledTimes(1);
  });
});
