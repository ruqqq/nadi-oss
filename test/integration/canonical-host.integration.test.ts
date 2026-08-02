import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Hosts come from the CANONICAL_HOST / LEGACY_HOSTS bindings in
// vitest.config.ts — the pool declares bindings explicitly rather than reading
// wrangler.jsonc. They are example values on purpose: the real deployment's
// hosts live in the private prod config, and this asserts the wiring, not them.
describe("canonical host redirects", () => {
  it("redirects a legacy host to the canonical one, preserving path and query", async () => {
    const res = await SELF.fetch("https://legacy.example.com/threads/example-thread?tab=activity", {
      redirect: "manual",
    });

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://app.example.com/threads/example-thread?tab=activity",
    );
  });

  it("does not redirect a host it has never been served from", async () => {
    const res = await SELF.fetch("https://other.example.com/api/health", { redirect: "manual" });

    expect(res.status).not.toBe(308);
  });
});
