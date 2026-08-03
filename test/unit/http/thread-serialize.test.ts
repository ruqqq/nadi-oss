import { describe, expect, it } from "vitest";
import { serializeThread } from "../../../src/http/thread-serialize";

describe("serializeThread reasoning fields", () => {
  const base = {
    id: "thr_1",
    workspaceId: "ws_1",
    agentId: "ag_1",
    runtime: "think" as const,
    title: "Hello",
    source: "manual" as const,
    lastMessagePreview: "",
    createdAt: 1,
    updatedAt: 2,
  };

  it("includes reasoningEffort and modelSupportsReasoning from the row", () => {
    const summary = serializeThread({
      ...base,
      modelProvider: "anthropic",
      model: "claude-opus-4-8",
      reasoningEffort: "high",
      modelSupportsReasoning: true,
    });
    expect(summary.reasoningEffort).toBe("high");
    expect(summary.modelSupportsReasoning).toBe(true);
  });

  it("defaults missing effort to medium and unknown capability to null", () => {
    const summary = serializeThread(base);
    expect(summary.reasoningEffort).toBe("medium");
    expect(summary.modelSupportsReasoning).toBeNull();
  });

  it("preserves an explicit false capability", () => {
    const summary = serializeThread({
      ...base,
      reasoningEffort: "off",
      modelSupportsReasoning: false,
    });
    expect(summary.reasoningEffort).toBe("off");
    expect(summary.modelSupportsReasoning).toBe(false);
  });
});
