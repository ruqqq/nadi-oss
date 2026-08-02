import { THREAD_SEARCH_MAX_QUERY_CHARS, THREAD_SEARCH_MAX_QUERY_TOKENS } from "./types";

const tokenPattern = /[\p{L}\p{N}_]+/gu;

export function buildFtsMatchQuery(input: string): string {
  const value = input.trim();
  if (value === "") throw new Error("empty_search_query");
  if (value.length > THREAD_SEARCH_MAX_QUERY_CHARS) throw new Error("search_query_too_long");
  const tokens = Array.from(value.matchAll(tokenPattern), (match) => match[0]).slice(
    0,
    THREAD_SEARCH_MAX_QUERY_TOKENS,
  );
  if (tokens.length === 0) throw new Error("empty_search_query");
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}
