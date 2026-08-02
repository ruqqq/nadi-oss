import {
  WebToolError,
  type WebSearchArgs,
  type WebSearchProvider,
  type WebSearchResponse,
  type WebSearchResult,
} from "./types";

interface ExaConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface ExaRawResult {
  title?: string;
  url: string;
  text?: string;
  snippet?: string;
  publishedDate?: string;
}

interface ExaRawResponse {
  results?: ExaRawResult[];
  answer?: string;
}

export const EXA_MAX_RESULTS = 25;

export type ExaKeyVerificationReason = "valid" | "invalid" | "unreachable";

const EXA_DEFAULT_BASE_URL = "https://api.exa.ai";

function exaSearchUrl(baseUrl?: string): string {
  return `${(baseUrl ?? EXA_DEFAULT_BASE_URL).replace(/\/$/, "")}/search`;
}

/**
 * Validate an Exa key without spending a search credit. Exa only exposes the
 * billed /search endpoint, but it authenticates before it validates the body:
 * an empty body yields 401 for a rejected key and a 400 for an accepted one.
 * So a definitive 401/403 blocks, while 5xx/network only means unreachable and
 * callers can soft-allow rather than trap the user behind an Exa outage.
 */
export async function verifyExaKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl?: string,
): Promise<{ reason: ExaKeyVerificationReason }> {
  try {
    const res = await fetchImpl(exaSearchUrl(baseUrl), {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { reason: "invalid" };
    if (res.ok || res.status === 400) return { reason: "valid" };
    return { reason: "unreachable" };
  } catch {
    return { reason: "unreachable" };
  }
}

export class ExaWebSearcher implements WebSearchProvider {
  constructor(private readonly config: ExaConfig) {}

  async search(args: WebSearchArgs): Promise<WebSearchResponse> {
    const numResults = clamp(args.numResults ?? 5, 1, EXA_MAX_RESULTS);
    const body: Record<string, unknown> = {
      query: args.query,
      numResults,
      type: "auto",
    };

    if (args.recency) {
      body.startPublishedDate = recencyToDate(args.recency);
    }
    if (args.includeDomains?.length) {
      body.includeDomains = args.includeDomains;
    }
    if (args.excludeDomains?.length) {
      body.excludeDomains = args.excludeDomains;
    }

    let response: Response;
    try {
      response = await fetch(
        `${(this.config.baseUrl ?? "https://api.exa.ai").replace(/\/$/, "")}/search`,
        {
          method: "POST",
          headers: {
            "x-api-key": this.config.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        },
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const isAbort = caught instanceof DOMException && caught.name === "AbortError";
      if (isAbort) {
        throw new WebToolError("timeout", "search request timed out");
      }
      throw new WebToolError("provider_error", message);
    }

    if (!response.ok) {
      throw new WebToolError("provider_error", `exa http ${response.status}`, {
        status: response.status,
      });
    }

    const json = (await response.clone().json()) as ExaRawResponse;
    const results: WebSearchResult[] = (json.results ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.url,
      snippet: result.text ?? result.snippet ?? "",
      ...(result.publishedDate === undefined ? {} : { publishedAt: result.publishedDate }),
    }));

    return {
      results,
      ...(json.answer === undefined ? {} : { answer: json.answer }),
    };
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

function recencyToDate(recency: "day" | "week" | "month" | "year"): string {
  const ms = {
    day: 1 * 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  }[recency];
  return new Date(Date.now() - ms).toISOString().slice(0, 10);
}
