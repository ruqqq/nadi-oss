import {
  grepOutputChunks,
  readOutputChunks,
  trimUtf8,
  type GrepOutputResult,
  type OutputChunkView,
  type ReadOutputResult,
} from "../compute/output";
import { WebToolError } from "./types";

export const WEB_READ_DEFAULT_MAX_BYTES = 50_000;
export const WEB_GREP_DEFAULT_MAX_MATCHES = 50;
export const WEB_GREP_DEFAULT_MAX_RETURNED_LINES = 200;
export const WEB_GREP_DEFAULT_MAX_BYTES = 50_000;
export const WEB_MAX_DOCUMENTS = 20;
export const WEB_MAX_SEARCHES = 20;
export const WEB_MAX_TOTAL_DOCUMENT_BYTES = 8_000_000;

export interface WebDocumentMeta {
  documentId: string;
  url: string;
  finalUrl: string;
  contentType: string;
  title?: string;
  byteSize: number;
  lineCount: number;
  truncated: boolean;
  via: "direct" | "browser";
}

export interface WebSearchResultCacheEntry {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

interface WebDocumentRow extends Record<string, string | number | null> {
  id: string;
  url: string;
  final_url: string;
  content_type: string;
  title: string | null;
  body: string;
  byte_size: number;
  line_count: number;
  truncated: number;
  via: string;
  created_at: number;
}

interface WebSearchRow extends Record<string, string | number | null> {
  id: string;
  query: string;
  results_json: string;
  created_at: number;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** One synthetic chunk covering the whole document so the sandbox output
 *  helpers (line/byte slicing, grep) apply unchanged. web_fetch writes the
 *  body once, so no multi-chunk streaming bookkeeping is needed. */
export function buildDocumentChunkView(body: string): OutputChunkView[] {
  if (body.length === 0) return [];
  return [
    {
      stream: "stdout",
      lineStart: 1,
      lineEnd: Math.max(countLines(body), 1),
      byteStart: 0,
      byteEnd: utf8ByteLength(body),
      text: body,
    },
  ];
}

export class WebDocumentStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS web_documents (
        id text primary key,
        url text not null,
        final_url text not null,
        content_type text not null,
        title text,
        body text not null,
        byte_size integer not null,
        line_count integer not null,
        truncated integer not null,
        via text not null,
        created_at integer not null
      )
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS web_searches (
        id text primary key,
        query text not null,
        results_json text not null,
        created_at integer not null
      )
    `);
  }

  writeDocument(input: {
    url: string;
    finalUrl: string;
    contentType: string;
    title?: string;
    body: string;
    truncated: boolean;
    via: "direct" | "browser";
  }): WebDocumentMeta {
    const id = `webdoc_${crypto.randomUUID()}`;
    const byteSize = utf8ByteLength(input.body);
    const lineCount = countLines(input.body);
    const now = Date.now();
    this.storage.sql.exec(
      `INSERT INTO web_documents
        (id, url, final_url, content_type, title, body, byte_size, line_count, truncated, via, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.url,
      input.finalUrl,
      input.contentType,
      input.title ?? null,
      input.body,
      byteSize,
      lineCount,
      input.truncated ? 1 : 0,
      input.via,
      now,
    );
    this.evictOldDocuments();
    return {
      documentId: id,
      url: input.url,
      finalUrl: input.finalUrl,
      contentType: input.contentType,
      ...(input.title === undefined ? {} : { title: input.title }),
      byteSize,
      lineCount,
      truncated: input.truncated,
      via: input.via,
    };
  }

  private getRow(id: string): WebDocumentRow | undefined {
    return this.storage.sql
      .exec<WebDocumentRow>("SELECT * FROM web_documents WHERE id = ?", id)
      .toArray()[0];
  }

  getDocumentMeta(id: string): WebDocumentMeta | null {
    const row = this.getRow(id);
    if (!row) return null;
    return {
      documentId: row.id,
      url: row.url,
      finalUrl: row.final_url,
      contentType: row.content_type,
      ...(row.title === null ? {} : { title: row.title }),
      byteSize: row.byte_size,
      lineCount: row.line_count,
      truncated: row.truncated === 1,
      via: row.via as "direct" | "browser",
    };
  }

  readDocument(
    id: string,
    range: { startLine?: number; endLine?: number; startByte?: number; maxBytes?: number },
  ): ReadOutputResult {
    const row = this.getRow(id);
    if (!row) throw new WebToolError("document_not_found", `no such document: ${id}`);
    const chunks = buildDocumentChunkView(row.body);
    return readOutputChunks(chunks, {
      stream: "stdout",
      ...(range.startLine === undefined ? {} : { startLine: range.startLine }),
      ...(range.endLine === undefined ? {} : { endLine: range.endLine }),
      ...(range.startByte === undefined ? {} : { startByte: range.startByte }),
      maxBytes: range.maxBytes ?? WEB_READ_DEFAULT_MAX_BYTES,
    });
  }

  grepDocument(
    id: string,
    opts: { pattern: string; contextLines?: number; maxMatches?: number; caseSensitive?: boolean },
  ): GrepOutputResult {
    const row = this.getRow(id);
    if (!row) throw new WebToolError("document_not_found", `no such document: ${id}`);
    const chunks = buildDocumentChunkView(row.body);
    return grepOutputChunks(chunks, {
      pattern: opts.pattern,
      stream: "stdout",
      caseSensitive: opts.caseSensitive ?? false,
      contextLines: opts.contextLines ?? 0,
      maxMatches: opts.maxMatches ?? WEB_GREP_DEFAULT_MAX_MATCHES,
      maxReturnedLines: WEB_GREP_DEFAULT_MAX_RETURNED_LINES,
      maxBytes: WEB_GREP_DEFAULT_MAX_BYTES,
    });
  }

  putSearch(query: string, results: WebSearchResultCacheEntry[]): string {
    const id = `websearch_${crypto.randomUUID()}`;
    this.storage.sql.exec(
      `INSERT INTO web_searches (id, query, results_json, created_at) VALUES (?, ?, ?, ?)`,
      id,
      trimUtf8(query, 2_000),
      JSON.stringify(results),
      Date.now(),
    );
    this.evictOldSearches();
    return id;
  }

  getSearch(id: string): { query: string; results: WebSearchResultCacheEntry[] } | null {
    const row = this.storage.sql
      .exec<WebSearchRow>("SELECT * FROM web_searches WHERE id = ?", id)
      .toArray()[0];
    if (!row) return null;
    return { query: row.query, results: JSON.parse(row.results_json) as WebSearchResultCacheEntry[] };
  }

  private evictOldDocuments(): void {
    this.storage.sql.exec(
      `DELETE FROM web_documents WHERE id NOT IN (
         SELECT id FROM web_documents ORDER BY created_at DESC LIMIT ?
       )`,
      WEB_MAX_DOCUMENTS,
    );

    // Bound total stored bytes too: repeatedly evict the oldest row while
    // over the cap. Never delete the last remaining row (the just-written
    // newest document is always <=1MB, well under the cap on its own).
    for (;;) {
      const row = this.storage.sql
        .exec<{ total: number; count: number }>(
          "SELECT COALESCE(SUM(byte_size),0) AS total, COUNT(*) AS count FROM web_documents",
        )
        .toArray()[0];
      if (!row || row.total <= WEB_MAX_TOTAL_DOCUMENT_BYTES || row.count <= 1) break;
      const oldest = this.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM web_documents ORDER BY created_at ASC, id ASC LIMIT 1",
        )
        .toArray()[0];
      if (!oldest) break;
      this.storage.sql.exec("DELETE FROM web_documents WHERE id = ?", oldest.id);
    }
  }

  private evictOldSearches(): void {
    this.storage.sql.exec(
      `DELETE FROM web_searches WHERE id NOT IN (
         SELECT id FROM web_searches ORDER BY created_at DESC LIMIT ?
       )`,
      WEB_MAX_SEARCHES,
    );
  }
}
