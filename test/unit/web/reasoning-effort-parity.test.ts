import { describe, expect, it } from "vitest";
import {
  buildReasoningProviderOptions,
  providerSupportsReasoningEffort as serverSupports,
} from "../../../src/agent/reasoning-options";
import { providerSupportsReasoningEffort as webSupports } from "../../../web/src/lib/reasoning-effort";
import { SUPPORTED_MODEL_PROVIDERS } from "../../../src/agent/model-config";

/**
 * The composer decides whether to offer the effort control from the WEB list;
 * the turn decides what to send from the SERVER one. Drift in either direction
 * is invisible without this: a provider added server-side would never surface a
 * control, and one added web-side would offer a control that silently does
 * nothing at turn time.
 *
 * This project pulls web/src into the strict root typecheck, so it can import
 * both trees — see nadi-web-lib-typechecked-under-worker-tsconfig.
 */
describe("reasoning effort provider parity", () => {
  it("agrees for every supported provider", () => {
    const disagreements = Object.keys(SUPPORTED_MODEL_PROVIDERS).filter(
      (provider) => serverSupports(provider) !== webSupports(provider),
    );
    expect(disagreements).toEqual([]);
  });

  it("agrees for providers outside the supported set too", () => {
    for (const provider of ["", "unknown", "openai-compatible", "opencode-go", "opencode-zen"]) {
      expect(webSupports(provider)).toBe(serverSupports(provider));
    }
  });

  it("never advertises a provider whose options come back empty", () => {
    // The stronger claim: agreeing lists are not enough if the mapping itself
    // forgets a case, which would offer a control that changes nothing.
    for (const provider of Object.keys(SUPPORTED_MODEL_PROVIDERS)) {
      if (!webSupports(provider)) continue;
      const options = buildReasoningProviderOptions(provider, { effort: "high" });
      expect(Object.keys(options).length, `${provider} advertised but emits nothing`).toBeGreaterThan(
        0,
      );
    }
  });
});
