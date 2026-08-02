import { describe, expect, it } from "vitest";
const egressProxyModule = "../../../infra/egress-proxy/server.mjs";
const { resolveRoute, filterRequestHeaders, filterResponseHeaders, ROUTES } = await import(
  egressProxyModule
);

describe("resolveRoute", () => {
  it("maps the openai-oauth route onto the codex upstream", () => {
    expect(resolveRoute("/openai-oauth/responses")?.upstreamUrl).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });

  it("maps the opencode-zen route onto the zen upstream", () => {
    expect(resolveRoute("/opencode-zen/chat/completions")?.upstreamUrl).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
  });

  it("preserves the query string", () => {
    expect(resolveRoute("/openai-oauth/responses?stream=true")?.upstreamUrl).toBe(
      "https://chatgpt.com/backend-api/codex/responses?stream=true",
    );
  });

  it("names the matched route", () => {
    expect(resolveRoute("/opencode-zen/models")?.name).toBe("opencode-zen");
  });

  it("carries the route's request-header allowlist", () => {
    expect(resolveRoute("/opencode-zen/models")?.route).toBe(ROUTES["opencode-zen"]);
  });

  it("keeps nested upstream paths intact", () => {
    expect(resolveRoute("/opencode-zen/v1/chat/completions")?.upstreamUrl).toBe(
      "https://opencode.ai/zen/v1/v1/chat/completions",
    );
  });

  it("rejects an unknown prefix", () => {
    expect(resolveRoute("/anthropic/messages")).toBeNull();
  });

  it("rejects the bare root the single-upstream proxy used to serve", () => {
    expect(resolveRoute("/responses")).toBeNull();
  });

  it("rejects a route prefix with no trailing path", () => {
    expect(resolveRoute("/openai-oauth")).toBeNull();
  });
});

describe("filterRequestHeaders", () => {
  const codexAllowlist = ROUTES["openai-oauth"].requestHeaders;
  const zenAllowlist = ROUTES["opencode-zen"].requestHeaders;

  it("keeps only the codex safelist", () => {
    const out = filterRequestHeaders(
      {
        authorization: "Bearer codex",
        "chatgpt-account-id": "acct",
        "openai-beta": "responses=experimental",
        "content-type": "application/json",
        accept: "text/event-stream",
        host: "vm.example.com:8088",
        "x-exedev-authorization": "Bearer vm",
        "x-exedev-userid": "user-123",
        "x-forwarded-for": "1.2.3.4",
        connection: "keep-alive",
      },
      codexAllowlist,
    );
    expect(out).toEqual({
      authorization: "Bearer codex",
      "chatgpt-account-id": "acct",
      "openai-beta": "responses=experimental",
      "content-type": "application/json",
      accept: "text/event-stream",
    });
  });

  it("does not leak codex-only headers onto the zen upstream", () => {
    const out = filterRequestHeaders(
      {
        authorization: "Bearer zen",
        "content-type": "application/json",
        accept: "text/event-stream",
        "chatgpt-account-id": "acct",
        "openai-beta": "responses=experimental",
      },
      zenAllowlist,
    );
    expect(out).toEqual({
      authorization: "Bearer zen",
      "content-type": "application/json",
      accept: "text/event-stream",
    });
  });

  it("is case-insensitive on header names", () => {
    const out = filterRequestHeaders(
      { Authorization: "Bearer codex", "Chatgpt-Account-Id": "acct" },
      codexAllowlist,
    );
    expect(out).toEqual({
      authorization: "Bearer codex",
      "chatgpt-account-id": "acct",
    });
  });
});

describe("filterResponseHeaders", () => {
  it("forwards content-type and cache-control, drops hop-by-hop headers", () => {
    const out = filterResponseHeaders({
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "transfer-encoding": "chunked",
      "content-length": "123",
      connection: "keep-alive",
      "content-encoding": "gzip",
      "set-cookie": "__cf_bm=abc",
    });
    expect(out).toEqual({
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
  });

  it("forwards throttle hints so the caller's backoff can read them", () => {
    const out = filterResponseHeaders({
      "content-type": "application/json",
      "retry-after": "30",
      "retry-after-ms": "30000",
    });
    expect(out).toEqual({
      "content-type": "application/json",
      "retry-after": "30",
      "retry-after-ms": "30000",
    });
  });
});
