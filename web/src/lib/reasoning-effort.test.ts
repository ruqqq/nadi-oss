import { describe, expect, it } from "vitest";
import {
  availableEffortOptions,
  providerSupportsReasoningEffort,
  shouldOfferEffortControl,
} from "./reasoning-effort";

describe("shouldOfferEffortControl", () => {
  it("hides only on a KNOWN false, matching what the server actually sends", () => {
    // Unknown must OFFER the control. The server sends reasoning options for
    // unknown models, so hiding the control left the model visibly thinking
    // with no way to turn it down — and unknown is the common case, because
    // most provider catalogs publish no capability at all.
    expect(shouldOfferEffortControl({ provider: "anthropic", modelSupportsReasoning: true })).toBe(
      true,
    );
    expect(shouldOfferEffortControl({ provider: "anthropic", modelSupportsReasoning: null })).toBe(
      true,
    );
    expect(shouldOfferEffortControl({ provider: "anthropic", modelSupportsReasoning: false })).toBe(
      false,
    );
  });

  it("requires the provider to have a vocabulary too", () => {
    // A reasoning model on a provider with no knob is still uncontrollable, so
    // showing a control there would be a lie.
    expect(
      shouldOfferEffortControl({ provider: "openai-compatible", modelSupportsReasoning: true }),
    ).toBe(false);
    // Including when capability is unknown, which is the common case there.
    expect(
      shouldOfferEffortControl({ provider: "openai-compatible", modelSupportsReasoning: null }),
    ).toBe(false);
    // The opencode gateways are addressable now — models.dev declares their
    // models' vocabularies — so they must NOT be in this list.
    expect(
      shouldOfferEffortControl({ provider: "opencode-zen", modelSupportsReasoning: true }),
    ).toBe(true);
    expect(shouldOfferEffortControl({ provider: "workers-ai", modelSupportsReasoning: true })).toBe(
      false,
    );
  });

  it("hides when no provider is chosen yet", () => {
    expect(shouldOfferEffortControl({ provider: null, modelSupportsReasoning: true })).toBe(false);
    expect(shouldOfferEffortControl({ provider: null, modelSupportsReasoning: null })).toBe(false);
  });
});

describe("providerSupportsReasoningEffort", () => {
  it("covers the providers with a real vocabulary", () => {
    for (const provider of [
      "openai",
      "openai-oauth",
      "anthropic",
      "openrouter",
      "deepseek",
      "zai",
      "qwen",
    ]) {
      expect(providerSupportsReasoningEffort(provider)).toBe(true);
    }
    // models.dev confirms every opencode-go model reasons, and Zen publishes 80
    // reasoning models, each with a declared vocabulary.
    for (const provider of ["opencode-go", "opencode-zen"]) {
      expect(providerSupportsReasoningEffort(provider)).toBe(true);
    }
    for (const provider of ["openai-compatible", "workers-ai"]) {
      expect(providerSupportsReasoningEffort(provider)).toBe(false);
    }
  });
});

describe("availableEffortOptions", () => {
  it("keeps the full set when controls are UNKNOWN", () => {
    // Absence of an entry is not evidence a model lacks granularity.
    expect(availableEffortOptions(undefined).map((o) => o.level)).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("offers nothing when the model reasons but exposes no control", () => {
    // Distinct from unknown — kimi-k2.7-code always thinks and cannot be tuned.
    expect(availableEffortOptions([])).toEqual([]);
  });

  it("gives a toggle-only model two honest states", () => {
    // 12 of 13 GLM models. Calling one of two states "High" overstates it.
    expect(availableEffortOptions([{ type: "toggle" }])).toEqual([
      { level: "off", label: "Off" },
      { level: "medium", label: "On" },
    ]);
  });

  it("uses the model's own scale words when it declares fewer than three", () => {
    expect(availableEffortOptions([{ type: "effort", values: ["high", "max"] }])).toEqual([
      { level: "off", label: "Off" },
      { level: "low", label: "High" },
      { level: "high", label: "Max" },
    ]);
  });

  it("ignores `none` as an intensity, since it is the off switch", () => {
    expect(
      availableEffortOptions([{ type: "effort", values: ["none", "low", "high"] }]).map(
        (o) => o.label,
      ),
    ).toEqual(["Off", "Low", "High"]);
  });

  it("keeps our own labels when the model's scale is at least as fine", () => {
    expect(
      availableEffortOptions([{ type: "effort", values: ["low", "medium", "high", "max"] }]).map(
        (o) => o.level,
      ),
    ).toEqual(["off", "low", "medium", "high"]);
  });

  it("treats a token budget as continuous, so our three levels stand", () => {
    expect(availableEffortOptions([{ type: "budget_tokens", min: 1024 }]).map((o) => o.level)).toEqual(
      ["off", "low", "medium", "high"],
    );
  });
});
