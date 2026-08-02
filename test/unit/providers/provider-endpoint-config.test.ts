import { describe, expect, it } from "vitest";
import {
  defaultProviderEndpointConfig,
  parseProviderEndpointConfig,
  stringifyProviderEndpointConfig,
} from "../../../src/db/repositories/provider-configs";
import { isProviderUsable } from "../../../src/settings/provider-settings";

describe("proxyUrl in the endpoint config", () => {
  it("round-trips a proxy route for a provider that has one", () => {
    const json = stringifyProviderEndpointConfig("opencode-zen", {
      baseUrl: "https://opencode.ai/zen/v1",
      proxyUrl: "https://proxy.example.com/opencode-zen",
      auth: "bearer",
      body: {},
    });
    expect(parseProviderEndpointConfig("opencode-zen", json).proxyUrl).toBe(
      "https://proxy.example.com/opencode-zen",
    );
  });

  it("keeps the provider's own endpoint alongside the proxy route", () => {
    const json = stringifyProviderEndpointConfig("opencode-zen", {
      baseUrl: "https://opencode.ai/zen/v1",
      proxyUrl: "https://proxy.example.com/opencode-zen",
      auth: "bearer",
      body: {},
    });
    expect(parseProviderEndpointConfig("opencode-zen", json).baseUrl).toBe(
      "https://opencode.ai/zen/v1",
    );
  });

  it("strips a trailing slash so the route prefix stays exact", () => {
    const json = stringifyProviderEndpointConfig("openai-oauth", {
      proxyUrl: "https://proxy.example.com/openai-oauth/",
    });
    expect(parseProviderEndpointConfig("openai-oauth", json).proxyUrl).toBe(
      "https://proxy.example.com/openai-oauth",
    );
  });

  it("defaults to direct egress", () => {
    expect(defaultProviderEndpointConfig("opencode-zen").proxyUrl).toBe("");
    expect(parseProviderEndpointConfig("opencode-zen", null).proxyUrl).toBe("");
  });

  it("rejects a proxy route for a provider the proxy does not serve", () => {
    expect(() =>
      stringifyProviderEndpointConfig("anthropic", {
        proxyUrl: "https://proxy.example.com/anthropic",
      }),
    ).toThrow("provider_proxy_url_unsupported");
  });

  it("ignores a proxy route stored against an unsupported provider", () => {
    const json = JSON.stringify({
      baseUrl: "",
      proxyUrl: "https://proxy.example.com/x",
      auth: "bearer",
    });
    expect(parseProviderEndpointConfig("anthropic", json).proxyUrl).toBe("");
  });

  it("rejects a non-HTTPS proxy route", () => {
    expect(() =>
      stringifyProviderEndpointConfig("opencode-zen", {
        baseUrl: "https://opencode.ai/zen/v1",
        proxyUrl: "http://proxy.example.com/opencode-zen",
      }),
    ).toThrow("provider_proxy_url_invalid");
  });

  it("allows localhost HTTP so wrangler dev can reach a local proxy", () => {
    expect(() =>
      stringifyProviderEndpointConfig("opencode-zen", {
        baseUrl: "https://opencode.ai/zen/v1",
        proxyUrl: "http://localhost:8088/opencode-zen",
      }),
    ).not.toThrow();
  });
});

describe("isProviderUsable", () => {
  const oauthConfig = (proxyUrl: string) => ({
    baseUrl: "",
    proxyUrl,
    auth: "bearer" as const,
    body: {},
  });

  // ChatGPT 403s Worker egress, so a token without a proxy route is not usable.
  it("requires a proxy route for openai-oauth, not just the token", () => {
    expect(isProviderUsable("openai-oauth", true, oauthConfig(""))).toBe(false);
    expect(
      isProviderUsable("openai-oauth", true, oauthConfig("https://proxy.example.com/openai-oauth")),
    ).toBe(true);
  });

  it("still requires the OAuth secret", () => {
    expect(
      isProviderUsable(
        "openai-oauth",
        false,
        oauthConfig("https://proxy.example.com/openai-oauth"),
      ),
    ).toBe(false);
  });

  // Zen works direct (paid models); the proxy is only what makes free ones work.
  it("does not require a proxy route for opencode-zen", () => {
    expect(
      isProviderUsable("opencode-zen", true, {
        baseUrl: "https://opencode.ai/zen/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      }),
    ).toBe(true);
  });
});
