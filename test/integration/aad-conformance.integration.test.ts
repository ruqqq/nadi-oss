import { describe, expect, it } from "vitest";
import { honoursAdditionalData } from "../../src/secrets/aad-conformance";

/**
 * The Cloudflare half of the celld v0.4.0 AAD finding, pinned on workerd
 * rather than assumed.
 *
 * celld v0.4.0 silently discarded AES-GCM `additionalData`, which left every
 * workspace secret it sealed with no binding to its slot and needing a
 * one-time re-wrap (`src/secrets/rewrap.ts`). The claim that Cloudflare needs
 * no such migration rests entirely on workerd authenticating AAD — so assert
 * it here, in the workers pool, instead of inferring it from the absence of
 * symptoms. A store whose AAD is ignored looks exactly like one that works.
 *
 * The re-wrap's own unit tests run under plain node, so this is the only place
 * the production runtime is measured.
 */
describe("AES-GCM additionalData on workerd", () => {
  it("is authenticated, so records sealed here are already bound", async () => {
    await expect(honoursAdditionalData()).resolves.toBe(true);
  });
});
