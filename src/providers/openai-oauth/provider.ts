import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { log } from "../../log";
import { applyProxyGateHeader, stripEgressHeaders } from "../egress-proxy";
import type { OpenAIOAuthAuthManager } from "./auth";

const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_INSTRUCTIONS = "You are Codex, a cloud-based agent running in ChatGPT.";
const CODEX_DIRECT_USER_AGENT = "codex_cli_rs/0.0.1";
const CODEX_DIRECT_ORIGINATOR = "codex_cli_rs";
const CODEX_MAX_ATTEMPTS = 4;
const CODEX_BASE_RETRY_DELAY_MS = 1_000;

export function createCodexOAuthFetch(input: {
  auth: OpenAIOAuthAuthManager;
  fetch?: typeof fetch;
  baseURL?: string;
  egressMode?: "direct" | "proxy";
  logContext?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * When set, the request is gated by an exe.dev VM token via the
   * `X-Exedev-Authorization` header. Used when routing through the egress proxy;
   * exe.dev validates and strips this header before forwarding to the VM.
   */
  exedevToken?: string;
}): typeof fetch {
  const fetchImpl = input.fetch ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseURL = withoutTrailingSlash(input.baseURL ?? CODEX_BACKEND_BASE_URL);
  const egressMode = input.egressMode ?? (input.exedevToken === undefined ? "direct" : "proxy");
  return async (requestInfo, init) => {
    const request = await readRequestParts(requestInfo, init);
    const url = resolveTargetUrl(request.url, baseURL);
    const headers = new Headers(request.headers);
    stripEgressHeaders(headers);
    headers.delete("authorization");
    headers.delete("chatgpt-account-id");
    headers.delete("openai-beta");
    const authHeaders = await input.auth.getAuthHeaders();
    for (const [key, value] of Object.entries(authHeaders)) headers.set(key, value);
    if (input.exedevToken !== undefined) {
      applyProxyGateHeader(headers, input.exedevToken);
    } else {
      applyDirectCodexMitigations(headers);
    }
    const body = await prepareResponsesBody(new URL(url).pathname, headers, request.body);

    const nextInit: RequestInit = {
      method: request.method,
      headers,
    };
    if (body !== undefined) nextInit.body = body;
    if (request.signal !== null) nextInit.signal = request.signal;
    for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(url, nextInit);
        const failedBodySnippet = !response.ok ? await readBodySnippet(response) : undefined;
        if (!response.ok) {
          logCodexFailure("codex.fetch_failed_response", {
            response,
            url,
            method: request.method,
            egressMode,
            logContext: input.logContext,
            bodySnippet: failedBodySnippet,
          });
        }
        if (
          response.ok ||
          attempt === CODEX_MAX_ATTEMPTS - 1 ||
          !isRetryableCodexResponse(response, failedBodySnippet, egressMode)
        ) {
          return response;
        }
        const delayMs = retryDelayMs(attempt, response.headers);
        log.warn("codex.fetch_retry", {
          ...input.logContext,
          method: request.method,
          egressMode,
          target: describeCodexTarget(url),
          status: response.status,
          attempt,
          delayMs,
        });
        await sleep(delayMs);
      } catch (error) {
        log.warn("codex.fetch_threw", {
          ...input.logContext,
          method: request.method,
          egressMode,
          target: describeCodexTarget(url),
          attempt,
          error: String(error),
        });
        if (attempt === CODEX_MAX_ATTEMPTS - 1) throw error;
        await sleep(retryDelayMs(attempt));
      }
    }
    throw new Error("codex_fetch_retry_loop_exhausted");
  };
}

function isRetryableCodexResponse(
  response: Response,
  bodySnippet: string | undefined,
  egressMode: "direct" | "proxy",
): boolean {
  if (egressMode !== "direct") return false;
  if (response.status === 429 || response.status === 500 || response.status === 502) return true;
  if (response.status === 503 || response.status === 504) return true;
  if (response.status !== 403) return false;
  return looksLikeCloudflareHtml(response, bodySnippet);
}

function looksLikeCloudflareHtml(response: Response, bodySnippet: string | undefined): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const server = response.headers.get("server")?.toLowerCase() ?? "";
  const body = bodySnippet?.toLowerCase() ?? "";
  return (
    contentType.includes("html") ||
    server.includes("cloudflare") ||
    body.includes("<html") ||
    body.includes("<!doctype html") ||
    body.includes("cloudflare") ||
    body.includes("just a moment")
  );
}

function retryDelayMs(attempt: number, headers?: Headers): number {
  const retryAfterMs = headers?.get("retry-after-ms");
  if (retryAfterMs) {
    const millis = Number(retryAfterMs);
    if (Number.isFinite(millis)) return Math.max(0, millis);
  }

  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  return CODEX_BASE_RETRY_DELAY_MS * 2 ** attempt;
}

export function createOpenAIOAuthModel(input: {
  model: string;
  auth: OpenAIOAuthAuthManager;
  fetch?: typeof fetch;
  logContext?: Record<string, string>;
  /**
   * Optional clean-egress proxy. When set, requests are sent to `proxy.url`
   * (instead of chatgpt.com directly) and gated with the exe.dev VM `proxy.token`.
   * Used to bypass ChatGPT's Cloudflare block on Cloudflare Worker egress.
   */
  proxy?: { url: string; token: string };
}): LanguageModel {
  const baseURL = input.proxy ? input.proxy.url : CODEX_BACKEND_BASE_URL;
  const egressMode = input.proxy ? "proxy" : "direct";

  const codexFetchInput: {
    auth: OpenAIOAuthAuthManager;
    fetch?: typeof fetch;
    baseURL: string;
    egressMode: "direct" | "proxy";
    logContext?: Record<string, string>;
    exedevToken?: string;
  } = {
    auth: input.auth,
    baseURL,
    egressMode,
  };
  if (input.fetch !== undefined) codexFetchInput.fetch = input.fetch;
  if (input.logContext !== undefined) codexFetchInput.logContext = input.logContext;
  if (input.proxy !== undefined) codexFetchInput.exedevToken = input.proxy.token;

  const provider = createOpenAI({
    name: "openai-oauth",
    apiKey: "oauth-placeholder",
    baseURL,
    fetch: createCodexOAuthFetch(codexFetchInput),
  });
  return provider.responses(input.model) as LanguageModel;
}

function applyDirectCodexMitigations(headers: Headers): void {
  if (!headers.has("accept")) headers.set("accept", "text/event-stream");
  if (!headers.has("originator")) headers.set("originator", CODEX_DIRECT_ORIGINATOR);
  if (!headers.has("user-agent")) headers.set("user-agent", CODEX_DIRECT_USER_AGENT);
}

function logCodexFailure(
  event: string,
  input: {
    response: Response;
    url: string;
    method: string;
    egressMode: "direct" | "proxy";
    logContext: Record<string, string> | undefined;
    bodySnippet?: string | undefined;
  },
): void {
  const headers = input.response.headers;
  log.warn(event, {
    ...input.logContext,
    method: input.method,
    egressMode: input.egressMode,
    target: describeCodexTarget(input.url),
    status: input.response.status,
    statusText: input.response.statusText,
    cfRay: headers.get("cf-ray") ?? undefined,
    cfMitigated: headers.get("cf-mitigated") ?? undefined,
    contentType: headers.get("content-type") ?? undefined,
    server: headers.get("server") ?? undefined,
    bodySnippet: input.bodySnippet,
  });
}

async function readBodySnippet(response: Response): Promise<string | undefined> {
  try {
    const text = await response.clone().text();
    return text.slice(0, 512);
  } catch {
    return undefined;
  }
}

function describeCodexTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

async function readRequestParts(
  requestInfo: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null;
}> {
  if (requestInfo instanceof Request) {
    const headers = new Headers(requestInfo.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    return {
      url: requestInfo.url,
      method: init?.method ?? requestInfo.method,
      headers,
      body:
        init?.body ?? (requestInfo.body === null ? undefined : await requestInfo.clone().text()),
      signal: init?.signal ?? requestInfo.signal,
    };
  }

  return {
    url: String(requestInfo),
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: init?.body,
    signal: init?.signal ?? null,
  };
}

async function prepareResponsesBody(
  pathname: string,
  headers: Headers,
  body: BodyInit | null | undefined,
): Promise<BodyInit | null | undefined> {
  if (!pathname.endsWith("/responses")) return body;
  const contentType = headers.get("content-type");
  if (contentType && !contentType.includes("application/json")) return body;
  if (typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    return JSON.stringify(normalizeResponsesBody(parsed));
  } catch {
    return body;
  }
}

function normalizeResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...body };
  if (typeof normalized.instructions !== "string") {
    normalized.instructions = DEFAULT_CODEX_INSTRUCTIONS;
  }
  normalized.stream = true;
  if (normalized.store === undefined) {
    normalized.store = false;
  }
  delete normalized.max_output_tokens;
  return normalized;
}

function resolveTargetUrl(inputUrl: string, baseURL: string): string {
  const base = new URL(baseURL);
  const parsed = /^https?:\/\//.test(inputUrl) ? new URL(inputUrl) : new URL(inputUrl, base);
  let pathname = parsed.pathname;
  const basePath = withoutTrailingSlash(base.pathname);
  if (pathname === basePath) {
    pathname = "/";
  } else if (basePath.length > 0 && pathname.startsWith(`${basePath}/`)) {
    pathname = pathname.slice(basePath.length);
  }
  if (pathname === "/v1") {
    pathname = "/";
  } else if (pathname.startsWith("/v1/")) {
    pathname = pathname.slice(3);
  }
  return `${base.origin}${basePath}${pathname}${parsed.search}`;
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
