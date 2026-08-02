import { describe, expect, it } from "vitest";
import { resolveContextWindow } from "../../../src/agent/context-window";
import { DEFAULT_CONTEXT_WINDOW } from "../../../src/agent/context-budget";

const noEnv = {} as { THINK_COMPACT_AFTER_TOKENS?: string };

describe("resolveContextWindow", () => {
  it("reads the window from the curated catalog", () => {
    // deepseek/deepseek-v4-pro is curated with a 1M contextLength.
    const window = resolveContextWindow({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      env: noEnv,
    });
    expect(window).toBeGreaterThan(DEFAULT_CONTEXT_WINDOW);
  });

  it("falls back to the conservative default for an unknown model", () => {
    expect(
      resolveContextWindow({ provider: "openai-compatible", model: "mystery-1", env: noEnv }),
    ).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("lets the operator override an unknown model via env", () => {
    expect(
      resolveContextWindow({
        provider: "openai-compatible",
        model: "mystery-1",
        env: { THINK_COMPACT_AFTER_TOKENS: "64000" },
      }),
    ).toBe(64_000);
  });

  it("ignores a junk env override", () => {
    expect(
      resolveContextWindow({
        provider: "openai-compatible",
        model: "mystery-1",
        env: { THINK_COMPACT_AFTER_TOKENS: "not-a-number" },
      }),
    ).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("prefers the catalog over the env override for a known model", () => {
    // Ordering contract: a model we know beats an operator's blanket fallback.
    expect(
      resolveContextWindow({
        provider: "anthropic",
        model: "claude-opus-4-8",
        env: { THINK_COMPACT_AFTER_TOKENS: "64000" },
      }),
    ).toBe(1_000_000);
  });
});
