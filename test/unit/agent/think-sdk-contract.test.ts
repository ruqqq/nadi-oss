import { describe, expect, it } from "vitest";
import { Think } from "@cloudflare/think";

/**
 * Nadi overrides these Think internals (see ThinkThreadAgent). They are declared
 * `private` in Think's typings but are ordinary prototype methods at runtime.
 *
 * If an SDK upgrade renames or removes one, our override stops running SILENTLY:
 * the model quietly reverts to the SDK's default truncation (aged tool outputs
 * cut to 500 chars) and no test would otherwise notice. Fail loudly here instead.
 */
describe("Think SDK contract", () => {
  it.each([
    "_assembleModelMessages",
    "_repairTranscriptForProvider",
    // The only funnel that knows whether an auto-compaction is proactive or
    // reactive; without the override the compaction log asserts "append".
    "_compactForContextOverflow",
  ])("still exposes %s on the prototype for ThinkThreadAgent to override", (method) => {
    expect(typeof (Think.prototype as unknown as Record<string, unknown>)[method]).toBe("function");
  });

  it("still passes the trigger reason as _compactForContextOverflow's first argument", () => {
    expect(
      (Think.prototype as unknown as { _compactForContextOverflow: (...a: unknown[]) => unknown })
        ._compactForContextOverflow.length,
    ).toBe(2);
  });

  it("still calls _assembleModelMessages with exactly one argument (tools)", () => {
    expect(
      (Think.prototype as unknown as { _assembleModelMessages: (tools: unknown) => unknown })
        ._assembleModelMessages.length,
    ).toBe(1);
  });
});

/**
 * The overlay-persistence bug: Think broadcasts the SYNTHETIC compaction overlay
 * to the client; the client posts its whole message list back on the next send;
 * the server reconciles against raw storage (which has no overlays) and upserts
 * the overlay as a REAL message. The summary becomes a permanent fake message and
 * the model reads it twice. ThinkThreadAgent overrides `_persistIncomingMessage`
 * to drop `compaction_*` ids — that override is silent if the SDK renames the
 * method, so pin it.
 */
describe("Think overlay-persistence seam", () => {
  it("still exposes _persistIncomingMessage for ThinkThreadAgent to override", () => {
    const proto = Think.prototype as unknown as Record<string, unknown>;
    expect(typeof proto._persistIncomingMessage).toBe("function");
    expect((proto._persistIncomingMessage as (...a: unknown[]) => unknown).length).toBe(2);
  });
});
