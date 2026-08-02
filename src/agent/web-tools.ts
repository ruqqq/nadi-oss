import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { createWorkspaceSecretsServices } from "../secrets";
import { trimUtf8 } from "../compute/output";
import { ExaWebSearcher } from "../web/exa-provider";
import { DirectWebFetcher } from "../web/direct-fetcher";
import { BrowserWebFetcher } from "../web/browser-fetcher";
import { FallbackWebFetcher } from "../web/fallback-fetcher";
import { WebDocumentStore, type WebSearchResultCacheEntry } from "../web/document-store";
import type { WebFetchProvider, WebSearchProvider } from "../web/types";

export const EXA_API_KEY_SECRET_NAME = "exa_api_key";
export const WEB_SEARCH_BATCH_CAP = 25;
export const WEB_SEARCH_DEFAULT_PAGE_SIZE = 5;
export const WEB_SEARCH_MAX_PAGE_SIZE = 10;
export const WEB_SEARCH_SNIPPET_MAX_BYTES = 1_000;
export const WEB_FETCH_PREVIEW_LINES = 40;
export const WEB_FETCH_PREVIEW_MAX_BYTES = 4_000;

export interface WebToolHostDeps {
  env: Env;
  threadId: string;
  storage: DurableObjectStorage;
  resolveRuntimeConfig: () => Promise<{ workspaceId: string }>;
  buildSearcher?: (apiKey: string) => WebSearchProvider;
  buildFetcher?: () => WebFetchProvider;
}

function toErrorResult(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

interface Cursor {
  searchId: string;
  offset: number;
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeCursor(raw: string): Cursor {
  const parsed = JSON.parse(atob(raw)) as Cursor;
  if (typeof parsed.searchId !== "string" || typeof parsed.offset !== "number") {
    throw new Error("invalid cursor");
  }
  return parsed;
}

export function buildWebToolDefs(
  getStore: () => WebDocumentStore,
  getFetcher: () => WebFetchProvider,
  getSearcher: (() => WebSearchProvider) | null,
): ToolSet {
  const tools: ToolSet = {
    web_fetch: tool({
      description:
        "Fetch a web page and store its content. Does NOT return the page body — it returns a documentId, metadata, and a short preview. Use web_fetch_read to read line/byte ranges and web_fetch_grep to search the stored content. Body is capped at 1MB.",
      inputSchema: z.object({
        url: z.string().describe("The absolute http(s) URL to fetch."),
        format: z.enum(["markdown", "text", "html"]).optional().describe("Defaults to markdown."),
      }),
      execute: async (input) => {
        try {
          const fetched = await getFetcher().fetch({
            url: input.url,
            ...(input.format === undefined ? {} : { format: input.format }),
          });
          const store = getStore();
          const meta = store.writeDocument({
            url: fetched.url,
            finalUrl: fetched.finalUrl,
            contentType: fetched.contentType,
            ...(fetched.title === undefined ? {} : { title: fetched.title }),
            body: fetched.content,
            truncated: fetched.truncated,
            via: fetched.via ?? "direct",
          });
          const preview = store.readDocument(meta.documentId, {
            startLine: 1,
            endLine: WEB_FETCH_PREVIEW_LINES,
            maxBytes: WEB_FETCH_PREVIEW_MAX_BYTES,
          });
          return { ...meta, preview: preview.text };
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    web_fetch_read: tool({
      description:
        "Read a bounded line or byte range from a stored web_fetch document. Provide startLine/endLine, or startByte/maxBytes. Output is bounded and reports whether it was limited.",
      inputSchema: z.object({
        documentId: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        startByte: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        try {
          return getStore().readDocument(input.documentId, {
            ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
            ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
            ...(input.startByte === undefined ? {} : { startByte: input.startByte }),
            ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
          });
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    web_fetch_grep: tool({
      description:
        "Search a stored web_fetch document with hard result limits. Returns matching lines with optional context.",
      inputSchema: z.object({
        documentId: z.string(),
        pattern: z.string(),
        caseSensitive: z.boolean().optional(),
        contextLines: z.number().int().nonnegative().optional(),
        maxMatches: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        try {
          return getStore().grepDocument(input.documentId, {
            pattern: input.pattern,
            ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
            ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
            ...(input.maxMatches === undefined ? {} : { maxMatches: input.maxMatches }),
          });
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
  };

  if (getSearcher) {
    tools.web_search = tool({
      description:
        "Search the web (Exa). Returns one page of results inline (title, url, snippet). To page further, pass the returned cursor back as `cursor` — this serves cached results without a new search. Use recency/includeDomains/excludeDomains to narrow.",
      inputSchema: z.object({
        query: z.string(),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(WEB_SEARCH_MAX_PAGE_SIZE)
          .optional()
          .describe(
            `Results per page (default ${WEB_SEARCH_DEFAULT_PAGE_SIZE}, max ${WEB_SEARCH_MAX_PAGE_SIZE}).`,
          ),
        cursor: z.string().optional().describe("Opaque cursor from a previous web_search result."),
        recency: z.enum(["day", "week", "month", "year"]).optional(),
        includeDomains: z.array(z.string()).optional(),
        excludeDomains: z.array(z.string()).optional(),
      }),
      execute: async (input) => {
        try {
          const store = getStore();
          const pageSize = Math.min(
            input.pageSize ?? WEB_SEARCH_DEFAULT_PAGE_SIZE,
            WEB_SEARCH_MAX_PAGE_SIZE,
          );

          let searchId: string;
          let all: WebSearchResultCacheEntry[];
          let offset: number;

          if (input.cursor) {
            const cursor = decodeCursor(input.cursor);
            const cached = store.getSearch(cursor.searchId);
            if (!cached) return { ok: false, error: "search_expired" };
            searchId = cursor.searchId;
            all = cached.results;
            offset = cursor.offset;
          } else {
            const response = await getSearcher!().search({
              query: input.query,
              numResults: WEB_SEARCH_BATCH_CAP,
              ...(input.recency === undefined ? {} : { recency: input.recency }),
              ...(input.includeDomains === undefined
                ? {}
                : { includeDomains: input.includeDomains }),
              ...(input.excludeDomains === undefined
                ? {}
                : { excludeDomains: input.excludeDomains }),
            });
            all = response.results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: trimUtf8(r.snippet, WEB_SEARCH_SNIPPET_MAX_BYTES),
              ...(r.publishedAt === undefined ? {} : { publishedAt: r.publishedAt }),
            }));
            searchId = store.putSearch(input.query, all);
            offset = 0;
          }

          const page = all.slice(offset, offset + pageSize);
          const nextOffset = offset + page.length;
          const hasMore = nextOffset < all.length;
          return {
            results: page,
            searchId,
            totalAvailable: all.length,
            ...(hasMore ? { nextCursor: encodeCursor({ searchId, offset: nextOffset }) } : {}),
          };
        } catch (error) {
          return toErrorResult(error);
        }
      },
    });
  }

  return tools;
}

export async function createWebTools(deps: WebToolHostDeps): Promise<ToolSet> {
  const store = new WebDocumentStore(deps.storage);
  store.migrate();

  const getStore = () => store;
  const getFetcher =
    deps.buildFetcher ??
    (() => {
      const direct = new DirectWebFetcher();
      if (deps.env.BROWSER) {
        return new FallbackWebFetcher({ direct, browser: new BrowserWebFetcher(deps.env.BROWSER) });
      }
      return direct;
    });

  const { workspaceId } = await deps.resolveRuntimeConfig();
  const secrets = createWorkspaceSecretsServices(deps.env);
  const exaKey = await secrets.store.get(workspaceId, EXA_API_KEY_SECRET_NAME);
  const getSearcher = exaKey
    ? () =>
        deps.buildSearcher ? deps.buildSearcher(exaKey) : new ExaWebSearcher({ apiKey: exaKey })
    : null;

  return buildWebToolDefs(getStore, getFetcher, getSearcher);
}
