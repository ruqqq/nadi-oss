import { describe, expect, it, vi } from "vitest";
import { buildWebToolDefs } from "../../../src/agent/web-tools";
import { WebDocumentStore } from "../../../src/web/document-store";
import type { WebFetchProvider, WebSearchProvider } from "../../../src/web/types";

function fakeStore(): WebDocumentStore {
  const docs = new Map<string, { body: string }>();
  return {
    writeDocument: (i: { body: string }) => {
      docs.set("d1", { body: i.body });
      return {
        documentId: "d1",
        url: "u",
        finalUrl: "u",
        contentType: "text/markdown",
        byteSize: 1,
        lineCount: 2,
        truncated: false,
        via: "direct",
      };
    },
    readDocument: () => ({ text: "preview line", limited: false }),
    grepDocument: () => ({
      matches: [{ line: 1, stream: "stdout", lines: [{ stream: "stdout", line: 1, text: "hit" }] }],
      limited: false,
    }),
    putSearch: () => "s1",
    getSearch: () => ({
      query: "q",
      results: [{ title: "T", url: "https://a.com", snippet: "s" }],
    }),
  } as unknown as WebDocumentStore;
}

const fetcher: WebFetchProvider = {
  fetch: vi.fn().mockResolvedValue({
    url: "https://a.com",
    finalUrl: "https://a.com",
    contentType: "text/markdown",
    title: "T",
    content: "line one\nline two\n",
    truncated: false,
    via: "direct",
  }),
};

const searcher: WebSearchProvider = {
  search: vi.fn().mockResolvedValue({
    results: Array.from({ length: 12 }, (_, i) => ({
      title: `t${i}`,
      url: `https://a.com/${i}`,
      snippet: "s",
    })),
  }),
};

describe("buildWebToolDefs", () => {
  it("omits web_search when no searcher is available", () => {
    const tools = buildWebToolDefs(
      () => fakeStore(),
      () => fetcher,
      null,
    );
    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_fetch_grep", "web_fetch_read"]);
  });

  it("includes web_search when a searcher is available", () => {
    const tools = buildWebToolDefs(
      () => fakeStore(),
      () => fetcher,
      () => searcher,
    );
    expect(Object.keys(tools).sort()).toEqual([
      "web_fetch",
      "web_fetch_grep",
      "web_fetch_read",
      "web_search",
    ]);
  });

  it("web_fetch stores the body and returns a handle + preview, not the full body", async () => {
    const tools = buildWebToolDefs(
      () => fakeStore(),
      () => fetcher,
      null,
    );
    const result = (await tools.web_fetch!.execute!({ url: "https://a.com" }, {} as never)) as {
      documentId: string;
      preview: string;
      content?: string;
    };
    expect(result.documentId).toBe("d1");
    expect(result.preview).toContain("preview line");
    expect(result).not.toHaveProperty("content");
  });

  it("web_search returns one page inline with a nextCursor", async () => {
    const tools = buildWebToolDefs(
      () => fakeStore(),
      () => fetcher,
      () => searcher,
    );
    const result = (await tools.web_search!.execute!({ query: "hi" }, {} as never)) as {
      results: unknown[];
      searchId: string;
      nextCursor?: string;
      totalAvailable: number;
    };
    expect(result.results).toHaveLength(5);
    expect(result.searchId).toBe("s1");
    expect(result.totalAvailable).toBe(12);
    expect(result.nextCursor).toBeTruthy();
  });

  it("returns a structured error instead of throwing when the fetcher fails", async () => {
    const failing: WebFetchProvider = { fetch: vi.fn().mockRejectedValue(new Error("boom")) };
    const tools = buildWebToolDefs(
      () => fakeStore(),
      () => failing,
      null,
    );
    const result = await tools.web_fetch!.execute!({ url: "https://a.com" }, {} as never);
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("returns search_expired when the cursor's cached search is gone", async () => {
    const tools = buildWebToolDefs(
      () => fakeStore(),
      () => fetcher,
      () => searcher,
    );
    const first = (await tools.web_search!.execute!({ query: "hi" }, {} as never)) as {
      nextCursor?: string;
    };
    expect(first.nextCursor).toBeTruthy();

    const expiredStore = { ...fakeStore(), getSearch: () => null } as unknown as WebDocumentStore;
    const toolsWithExpiredStore = buildWebToolDefs(
      () => expiredStore,
      () => fetcher,
      () => searcher,
    );
    const result = await toolsWithExpiredStore.web_search!.execute!(
      { query: "hi", cursor: first.nextCursor },
      {} as never,
    );
    expect(result).toEqual({ ok: false, error: "search_expired" });
  });
});
