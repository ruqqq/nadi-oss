import { describe, expect, it } from "vitest";
import {
  buildReasoningProviderOptions,
  mapEffortToModelScale,
  parseReasoningEffort,
  providerSupportsReasoningEffort,
} from "../../../src/agent/reasoning-options";
import type { ModelReasoningProfile } from "../../../src/providers/models-dev";

/** Shapes copied from the live models.dev catalog (verified 2026-08-01). */
const PROFILES = {
  // anthropic/claude-opus-4-8 — effort, and NO budget_tokens.
  opusEffortOnly: {
    reasoning: true,
    controls: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  },
  // anthropic/claude-haiku-4-5 — budget only, no effort.
  haikuBudgetOnly: { reasoning: true, controls: [{ type: "budget_tokens", min: 1024 }] },
  // zhipuai/glm-5.1 — toggle only.
  glmToggleOnly: { reasoning: true, controls: [{ type: "toggle" }] },
  // zhipuai/glm-5.2 — a two-value scale that omits low and medium entirely.
  glmHighMax: { reasoning: true, controls: [{ type: "effort", values: ["high", "max"] }] },
  // deepseek/deepseek-chat — reasons, but exposes nothing to tune.
  noControls: { reasoning: true, controls: [] },
  // alibaba/qwen3.7-plus
  qwenToggleBudget: {
    reasoning: true,
    controls: [{ type: "toggle" }, { type: "budget_tokens", max: 262144 }],
  },
  notReasoning: { reasoning: false, controls: [] },
} satisfies Record<string, ModelReasoningProfile>;

describe("mapEffortToModelScale", () => {
  it("spans the model's own scale rather than assuming ours", () => {
    expect(mapEffortToModelScale("low", ["low", "medium", "high"])).toBe("low");
    expect(mapEffortToModelScale("high", ["low", "medium", "high"])).toBe("high");
    // A model offering only high|max must still distinguish our low from high.
    expect(mapEffortToModelScale("low", ["high", "max"])).toBe("high");
    expect(mapEffortToModelScale("high", ["high", "max"])).toBe("max");
    // Single-value scales collapse, which is the model's own limitation.
    expect(mapEffortToModelScale("low", ["max"])).toBe("max");
  });

  it("never targets `none`, which is an off switch and not an intensity", () => {
    expect(mapEffortToModelScale("low", ["none", "low", "high"])).toBe("low");
    expect(mapEffortToModelScale("high", ["none", "low", "high"])).toBe("high");
    expect(mapEffortToModelScale("low", ["none"])).toBeNull();
  });
});

describe("buildReasoningProviderOptions with a model profile", () => {
  it("sends anthropic an effort string when the model takes one, not a budget", () => {
    // The defect this replaces: claude-opus-4-8 declares effort and NO
    // budget_tokens, and we were sending it a budget regardless.
    const options = buildReasoningProviderOptions("anthropic", {
      effort: "high",
      profile: PROFILES.opusEffortOnly,
    });
    expect(options.anthropic?.thinking).toEqual({ type: "enabled", effort: "max" });
    expect(JSON.stringify(options)).not.toContain("budgetTokens");
  });

  it("still sends a budget to models that only take one", () => {
    const options = buildReasoningProviderOptions("anthropic", {
      effort: "low",
      profile: PROFILES.haikuBudgetOnly,
    });
    expect(options.anthropic?.thinking).toMatchObject({ type: "enabled", budgetTokens: 1024 });
  });

  it("sends a toggle-only model a toggle, never an effort string", () => {
    // 12 of 13 GLM models are toggle-only; we were sending them reasoningEffort.
    const options = buildReasoningProviderOptions("zai", {
      effort: "high",
      profile: PROFILES.glmToggleOnly,
    });
    expect(options.zai).toEqual({ thinking: { type: "enabled" } });
    expect(options.zai).not.toHaveProperty("reasoningEffort");
  });

  it("uses the model's own effort values where it declares them", () => {
    expect(
      buildReasoningProviderOptions("zai", { effort: "high", profile: PROFILES.glmHighMax }).zai,
    ).toMatchObject({ reasoningEffort: "max" });
  });

  it("sends nothing to a model that reasons but exposes no control", () => {
    // deepseek-chat. Guessing here is exactly what produced the wrong params.
    expect(
      buildReasoningProviderOptions("deepseek", { effort: "high", profile: PROFILES.noControls }),
    ).toEqual({});
  });

  it("combines a toggle with a budget where the model declares both", () => {
    const options = buildReasoningProviderOptions("qwen", {
      effort: "high",
      profile: PROFILES.qwenToggleBudget,
    });
    expect(options.qwen).toMatchObject({ enable_thinking: true });
    expect(options.qwen?.thinking_budget).toBeGreaterThan(1024);
  });

  it("emits nothing for a model the catalog says cannot reason", () => {
    expect(
      buildReasoningProviderOptions("anthropic", {
        effort: "high",
        profile: PROFILES.notReasoning,
      }),
    ).toEqual({});
  });

  it("turns a toggle-capable model off positively", () => {
    expect(
      buildReasoningProviderOptions("zai", { effort: "off", profile: PROFILES.glmToggleOnly }).zai,
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("turns OFF a model whose profile declares no toggle", () => {
    // opencode-go/deepseek-v4-flash declares effort(high|max) and no toggle,
    // and Off was a no-op: we sent nothing and the provider default (thinking
    // ON) applied. models.dev lists INTENSITY controls and is inconsistent
    // about toggles for the same model across providers, so its silence is not
    // evidence that no off switch exists.
    const profile = {
      reasoning: true,
      controls: [{ type: "effort" as const, values: ["high", "max"] }],
    };
    expect(
      buildReasoningProviderOptions("opencode-go", { effort: "off", profile })["opencode-go"],
    ).toEqual({ thinking: { type: "disabled" } });
    expect(buildReasoningProviderOptions("deepseek", { effort: "off", profile }).deepseek).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("prefers a declared `none` effort value over the generic disable", () => {
    const profile = {
      reasoning: true,
      controls: [{ type: "effort" as const, values: ["none", "low", "high"] }],
    };
    expect(buildReasoningProviderOptions("openai", { effort: "off", profile }).openai).toEqual({
      reasoningEffort: "none",
    });
  });

  it("turns anthropic off explicitly rather than by omission", () => {
    expect(
      buildReasoningProviderOptions("anthropic", {
        effort: "off",
        profile: PROFILES.haikuBudgetOnly,
      }).anthropic,
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("still tries to turn off a model that reasons but declares no controls", () => {
    // It reasons, so there is something to disable even if models.dev lists no
    // knob. Worst case the field is ignored.
    expect(
      buildReasoningProviderOptions("opencode-zen", {
        effort: "off",
        profile: PROFILES.noControls,
      }),
    ).toEqual({ "opencode-zen": { thinking: { type: "disabled" } } });
  });

  it("says nothing at all to a model that cannot reason", () => {
    // Nothing to disable, so no field is sent in either direction.
    expect(
      buildReasoningProviderOptions("anthropic", { effort: "off", profile: PROFILES.notReasoning }),
    ).toEqual({});
  });
});

describe("buildReasoningProviderOptions without a profile", () => {
  it("falls back to the provider's usual shape rather than going silent", () => {
    // A models.dev outage, or a model it has never heard of, must not stop
    // threads thinking.
    expect(
      buildReasoningProviderOptions("anthropic", { effort: "medium", profile: null }).anthropic,
    ).toEqual({ thinking: { type: "enabled", budgetTokens: 2048 } });
    expect(
      buildReasoningProviderOptions("openai", { effort: "high", profile: null }).openai,
    ).toEqual({ reasoningEffort: "high", reasoningSummary: "auto" });
  });

  it("honours the thread's recorded capability only as a fallback", () => {
    expect(
      buildReasoningProviderOptions("anthropic", {
        effort: "medium",
        modelSupportsReasoning: false,
      }),
    ).toEqual({});
    // Unknown still permits: pre-existing threads carry no capability.
    expect(
      buildReasoningProviderOptions("anthropic", {
        effort: "medium",
        modelSupportsReasoning: undefined,
      }).anthropic,
    ).toBeDefined();
  });

  it("a profile outranks the thread snapshot", () => {
    // The snapshot can be stale; models.dev is the live fact.
    expect(
      buildReasoningProviderOptions("anthropic", {
        effort: "medium",
        profile: PROFILES.opusEffortOnly,
        modelSupportsReasoning: false,
      }).anthropic,
    ).toBeDefined();
  });

  it("openai-oauth always keeps store:false", () => {
    expect(
      buildReasoningProviderOptions("openai-oauth", { effort: "off", profile: null }).openai,
    ).toEqual({ store: false });
    expect(
      buildReasoningProviderOptions("openai-oauth", { effort: "low", profile: null }).openai,
    ).toMatchObject({ store: false, reasoningSummary: "auto" });
  });

  it("emits nothing for providers we cannot address", () => {
    for (const provider of ["openai-compatible", "workers-ai", "mock", "mock-reasoning"]) {
      expect(buildReasoningProviderOptions(provider, { effort: "high" })).toEqual({});
    }
  });
});

describe("providerSupportsReasoningEffort", () => {
  it("covers every provider whose wire format we can write", () => {
    for (const provider of [
      "openai",
      "openai-oauth",
      "anthropic",
      "openrouter",
      "deepseek",
      "zai",
      "qwen",
      // Confirmed by models.dev: all 23 opencode-go models reason, and Zen
      // publishes 85 with 80 reasoning.
      "opencode-go",
      "opencode-zen",
    ]) {
      expect(providerSupportsReasoningEffort(provider)).toBe(true);
    }
    // openai-compatible points at an arbitrary endpoint; workers-ai has no
    // reasoning parameter in its binding.
    for (const provider of ["openai-compatible", "workers-ai", "mock"]) {
      expect(providerSupportsReasoningEffort(provider)).toBe(false);
    }
  });
});

describe("parseReasoningEffort", () => {
  it("accepts the four levels and rejects everything else", () => {
    expect(parseReasoningEffort("off")).toBe("off");
    expect(parseReasoningEffort("high")).toBe("high");
    expect(parseReasoningEffort("HIGH")).toBeNull();
    expect(parseReasoningEffort(2)).toBeNull();
    expect(parseReasoningEffort(undefined)).toBeNull();
  });
});
