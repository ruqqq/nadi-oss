import { afterEach, describe, expect, it, vi } from "vitest";
import { ExaWebSearcher, verifyExaKey } from "../../../src/web/exa-provider";
import { WebToolError } from "../../../src/web/types";

afterEach(() => vi.restoreAllMocks());

describe("ExaWebSearcher", () => {
  it("sends the api key + query and maps results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { title: "T", url: "https://a.com", text: "snip", publishedDate: "2026-01-01" },
          ],
          answer: "A",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const searcher = new ExaWebSearcher({ apiKey: "k" });
    const out = await searcher.search({ query: "hello", numResults: 3 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.exa.ai/search");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      query: "hello",
      numResults: 3,
      type: "auto",
    });
    expect(out.results).toEqual([
      { title: "T", url: "https://a.com", snippet: "snip", publishedAt: "2026-01-01" },
    ]);
    expect(out.answer).toBe("A");
  });

  it("throws provider_error on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const searcher = new ExaWebSearcher({ apiKey: "k" });
    await expect(searcher.search({ query: "x" })).rejects.toBeInstanceOf(WebToolError);
  });

  it("honors a batch request of 25 without clamping to 10", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const searcher = new ExaWebSearcher({ apiKey: "k" });
    await searcher.search({ query: "hello", numResults: 25 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ numResults: 25 });
  });

  it("defaults to 5 results when numResults is omitted", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const searcher = new ExaWebSearcher({ apiKey: "k" });
    await searcher.search({ query: "hello" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ numResults: 5 });
  });

  it("clamps a numResults above 25 down to 25", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const searcher = new ExaWebSearcher({ apiKey: "k" });
    await searcher.search({ query: "hello", numResults: 100 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ numResults: 25 });
  });
});

describe("verifyExaKey", () => {
  const statusFetch = (status: number) =>
    vi.fn<typeof fetch>(async () => new Response(null, { status }));

  it("posts an empty body so verification never spends a search credit", async () => {
    const fetchImpl = statusFetch(400);
    await verifyExaKey("exa_key", fetchImpl as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.exa.ai/search");
    expect(init!.method).toBe("POST");
    expect(init!.body).toBe("{}");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("exa_key");
  });

  it("treats 401 and 403 as a definitively rejected key", async () => {
    await expect(verifyExaKey("bad", statusFetch(401) as typeof fetch)).resolves.toEqual({
      reason: "invalid",
    });
    await expect(verifyExaKey("bad", statusFetch(403) as typeof fetch)).resolves.toEqual({
      reason: "invalid",
    });
  });

  it("treats 400 as valid — auth passed, only the empty body was rejected", async () => {
    await expect(verifyExaKey("good", statusFetch(400) as typeof fetch)).resolves.toEqual({
      reason: "valid",
    });
  });

  it("treats 2xx as valid", async () => {
    await expect(verifyExaKey("good", statusFetch(200) as typeof fetch)).resolves.toEqual({
      reason: "valid",
    });
  });

  it("treats 5xx as unreachable so an Exa outage never blocks setup", async () => {
    await expect(verifyExaKey("good", statusFetch(503) as typeof fetch)).resolves.toEqual({
      reason: "unreachable",
    });
  });

  it("treats a network error or timeout as unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    await expect(verifyExaKey("good", fetchImpl as typeof fetch)).resolves.toEqual({
      reason: "unreachable",
    });
  });

  it("honours a custom base URL", async () => {
    const fetchImpl = statusFetch(400);
    await verifyExaKey("k", fetchImpl as typeof fetch, "https://exa.test/");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://exa.test/search");
  });
});
