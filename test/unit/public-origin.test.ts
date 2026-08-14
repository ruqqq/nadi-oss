import { describe, expect, it } from "vitest";
import { rewriteToPublicOrigin } from "../../src/agent-routing/public-origin";

const callback = (origin: string) =>
  new URL(`${origin}/agents/workspace-mcp-agent/workspace:ws_1/callback?code=abc&state=xyz.s99`);

describe("rewriteToPublicOrigin", () => {
  it("restores https when a proxy terminated TLS and forwarded plain http", () => {
    const rewritten = rewriteToPublicOrigin(
      callback("http://nadi-beta.ruqqq.sg"),
      "https://nadi-beta.ruqqq.sg",
    );
    expect(rewritten?.origin).toBe("https://nadi-beta.ruqqq.sg");
  });

  it("preserves the OAuth code and state verbatim", () => {
    // These are what the SDK validates; a rewrite that touched them would turn
    // a routing bug into a silent auth failure.
    const rewritten = rewriteToPublicOrigin(
      callback("http://nadi-beta.ruqqq.sg"),
      "https://nadi-beta.ruqqq.sg",
    );
    expect(rewritten?.pathname).toBe("/agents/workspace-mcp-agent/workspace:ws_1/callback");
    expect(rewritten?.searchParams.get("code")).toBe("abc");
    expect(rewritten?.searchParams.get("state")).toBe("xyz.s99");
  });

  it("returns null when the request already carries the public origin", () => {
    // Cloudflare, and any celld deployment where Caddy terminates TLS itself.
    expect(
      rewriteToPublicOrigin(callback("https://nadi-beta.ruqqq.sg"), "https://nadi-beta.ruqqq.sg"),
    ).toBeNull();
  });

  it("refuses to rewrite across hostnames", () => {
    // A different host means a misrouted request, not a terminated TLS hop.
    expect(
      rewriteToPublicOrigin(callback("http://evil.example.com"), "https://nadi-beta.ruqqq.sg"),
    ).toBeNull();
  });

  it("carries the public port across", () => {
    const rewritten = rewriteToPublicOrigin(
      callback("http://nadi-beta.ruqqq.sg"),
      "https://nadi-beta.ruqqq.sg:8443",
    );
    expect(rewritten?.origin).toBe("https://nadi-beta.ruqqq.sg:8443");
  });

  it("leaves the request alone when APP_BASE_URL is missing or unparseable", () => {
    // A bad APP_BASE_URL must not take the callback down on deployments that
    // never needed the rewrite.
    expect(rewriteToPublicOrigin(callback("http://nadi-beta.ruqqq.sg"), undefined)).toBeNull();
    expect(rewriteToPublicOrigin(callback("http://nadi-beta.ruqqq.sg"), "not a url")).toBeNull();
  });
});
