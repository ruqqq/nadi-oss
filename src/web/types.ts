export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  answer?: string;
}

export interface WebSearchArgs {
  query: string;
  numResults?: number;
  recency?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface WebSearchProvider {
  search(args: WebSearchArgs): Promise<WebSearchResponse>;
}

export interface WebFetchArgs {
  url: string;
  format?: "markdown" | "text" | "html";
  maxBytes?: number;
  timeoutMs?: number;
}

export interface WebFetchResponse {
  url: string;
  finalUrl: string;
  contentType: string;
  title?: string;
  content: string;
  truncated: boolean;
  via?: "direct" | "browser";
}

export interface WebFetchProvider {
  fetch(args: WebFetchArgs): Promise<WebFetchResponse>;
}

export class WebToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
