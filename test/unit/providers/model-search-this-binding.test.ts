/**
 * Regression: fetchLiveModels used to invoke the injected fetch as
 * `input.fetchImpl(url, ...)` — a METHOD call, which binds `this` to the input
 * object. Cloudflare's native `fetch` throws "Illegal invocation: function
 * called with incorrect `this` reference" when `this` isn't the global, and
 * searchProviderModels swallows it via `.catch(() => null)` — silently degrading
 * every provider to its static model list in production.
 *
 * Every existing test missed this because they inject a plain closure, which
 * doesn't care about `this`. So this test asserts the *call style* instead: the
 * impl must be invoked as a plain function (`this === undefined` under ESM
 * strict mode), never as a method of some object.
 */
import { describe, expect, it, vi } from "vitest";
import { searchProviderModels } from "../../../src/providers/model-search";
import { defaultProviderEndpointConfig } from "../../../src/db/repositories/provider-configs";

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchLiveModels this-binding", () => {
  it("calls the injected fetch as a plain function, not as a method", async () => {
    const seen: unknown[] = [];
    // A non-arrow function so `this` is observable at the call site.
    const fetchImpl = function (this: unknown): Promise<Response> {
      seen.push(this);
      return Promise.resolve(modelsResponse(["deepseek-v4-flash-free", "gpt-5.5"]));
    } as unknown as typeof fetch;

    await searchProviderModels({
      provider: "opencode-zen",
      query: "",
      limit: 50,
      fetchImpl,
      secret: "sk-test",
      endpointConfig: defaultProviderEndpointConfig("opencode-zen"),
    });

    expect(seen).toHaveLength(1);
    // A method call would hand us the input object here. Native fetch would throw.
    expect(seen[0]).toBeUndefined();
  });

  it("surfaces live models when the impl is the bare global fetch", async () => {
    // The production call site passes the global `fetch` itself. Simulate a
    // native impl that refuses a bad `this`, exactly like the Workers runtime.
    const nativeLike = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(modelsResponse(["gpt-5.5", "claude-sonnet-5"]));
    } as unknown as typeof fetch;

    const result = await searchProviderModels({
      provider: "opencode-zen",
      query: "",
      limit: 50,
      fetchImpl: nativeLike,
      secret: "sk-test",
      endpointConfig: defaultProviderEndpointConfig("opencode-zen"),
    });

    // Before the fix this was "static" with the five curated free models — the
    // illegal-invocation throw was swallowed and nobody was told.
    expect(result.source).toBe("live");
    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.5", "claude-sonnet-5"]);
  });
});

describe("silent static fallback logging", () => {
  it("logs an error when the provider's model list is unhealthy", async () => {
    const emitted: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      emitted.push(line);
    });

    const result = await searchProviderModels({
      provider: "opencode-zen",
      query: "",
      limit: 50,
      fetchImpl: () => Promise.resolve(new Response("rate limited", { status: 429 })),
      secret: "sk-test",
      endpointConfig: defaultProviderEndpointConfig("opencode-zen"),
    });
    spy.mockRestore();

    // The user still gets a usable list — that degradation is intentional.
    expect(result.source).toBe("static");
    // But it must not be silent to us.
    const event = emitted
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "provider.model_list_failed");
    expect(event).toMatchObject({ level: "error", provider: "opencode-zen", status: 429 });
  });

  it("logs an error when the live fetch throws", async () => {
    const emitted: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      emitted.push(line);
    });

    await searchProviderModels({
      provider: "opencode-zen",
      query: "",
      limit: 50,
      fetchImpl: () => Promise.reject(new TypeError("Illegal invocation")),
      secret: "sk-test",
      endpointConfig: defaultProviderEndpointConfig("opencode-zen"),
    });
    spy.mockRestore();

    const event = emitted
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "provider.model_list_threw");
    expect(event).toMatchObject({ level: "error", provider: "opencode-zen" });
    expect(String(event.error)).toContain("Illegal invocation");
  });
});
