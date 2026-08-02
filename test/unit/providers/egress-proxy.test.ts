import { describe, expect, it } from "vitest";
import {
  applyProxyGateHeader,
  resolveEgressProxy,
  stripEgressHeaders,
} from "../../../src/providers/egress-proxy";
import type { Env } from "../../../src/env";

const env = (overrides: Partial<Env> = {}) => ({ ...overrides }) as Env;

describe("resolveEgressProxy", () => {
  it("returns the route and token when both halves are configured", () => {
    expect(
      resolveEgressProxy(env({ EGRESS_PROXY_TOKEN: "vm" }), "opencode-zen", {
        proxyUrl: "https://proxy.example.com/opencode-zen",
      }),
    ).toEqual({ url: "https://proxy.example.com/opencode-zen", token: "vm" });
  });

  it("goes direct when the workspace configured no route", () => {
    expect(
      resolveEgressProxy(env({ EGRESS_PROXY_TOKEN: "vm" }), "opencode-zen", { proxyUrl: "" }),
    ).toBeUndefined();
  });

  // Without the token the proxy would answer 401, so a configured route alone
  // must not divert traffic away from the provider.
  it("goes direct when the deployment has no VM token", () => {
    expect(
      resolveEgressProxy(env(), "opencode-zen", {
        proxyUrl: "https://proxy.example.com/opencode-zen",
      }),
    ).toBeUndefined();
  });

  it("refuses a proxy for a provider that has no route", () => {
    expect(
      resolveEgressProxy(env({ EGRESS_PROXY_TOKEN: "vm" }), "anthropic", {
        proxyUrl: "https://proxy.example.com/anthropic",
      }),
    ).toBeUndefined();
  });

  it("honours CODEX_DIRECT_ENABLED for openai-oauth", () => {
    expect(
      resolveEgressProxy(
        env({ EGRESS_PROXY_TOKEN: "vm", CODEX_DIRECT_ENABLED: "true" }),
        "openai-oauth",
        { proxyUrl: "https://proxy.example.com/openai-oauth" },
      ),
    ).toBeUndefined();
  });

  it("does not let CODEX_DIRECT_ENABLED divert other providers", () => {
    expect(
      resolveEgressProxy(
        env({ EGRESS_PROXY_TOKEN: "vm", CODEX_DIRECT_ENABLED: "true" }),
        "opencode-zen",
        { proxyUrl: "https://proxy.example.com/opencode-zen" },
      ),
    ).toEqual({ url: "https://proxy.example.com/opencode-zen", token: "vm" });
  });
});

describe("stripEgressHeaders", () => {
  it("removes the headers that would identify the Cloudflare origin", () => {
    const headers = new Headers({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      host: "worker.example.com",
      authorization: "Bearer sk",
    });
    stripEgressHeaders(headers);
    expect(headers.has("cf-connecting-ip")).toBe(false);
    expect(headers.has("x-forwarded-for")).toBe(false);
    expect(headers.has("host")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer sk");
  });
});

describe("applyProxyGateHeader", () => {
  it("sets the exe.dev VM bearer header", () => {
    const headers = new Headers();
    applyProxyGateHeader(headers, "vm");
    expect(headers.get("x-exedev-authorization")).toBe("Bearer vm");
  });
});
