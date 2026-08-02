import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectWebFetcher } from "../../../src/web/direct-fetcher";
import { WebToolError } from "../../../src/web/types";

afterEach(() => vi.restoreAllMocks());

describe("DirectWebFetcher", () => {
  it("fetches html and extracts the title", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><head><title> Hi </title></head><body><p>Body</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const out = await new DirectWebFetcher().fetch({ url: "https://a.com", format: "text" });
    expect(out.title).toBe("Hi");
    expect(out.content).toContain("Body");
    expect(out.via).toBe("direct");
  });

  it("rejects an SSRF target before fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(new DirectWebFetcher().fetch({ url: "http://127.0.0.1/x" })).rejects.toMatchObject(
      {
        code: "invalid_url",
      },
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a non-ok status to http_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 404 }));
    await expect(new DirectWebFetcher().fetch({ url: "https://a.com" })).rejects.toBeInstanceOf(
      WebToolError,
    );
  });
});
