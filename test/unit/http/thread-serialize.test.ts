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
    agentArchivedAt: null,
    agentEnabled: true,
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

describe("serializeThread readOnly and readOnlyReason", () => {
  const base = {
    id: "thr_1",
    workspaceId: "ws_1",
    agentId: "ag_1",
    runtime: "think" as const,
    title: "Hello",
    source: "manual" as const,
    lastMessagePreview: "",
    agentArchivedAt: null as number | null,
    agentEnabled: true as boolean | null,
    createdAt: 1,
    updatedAt: 2,
  };

  it("leaves a live thread writable with no reason on the wire", () => {
    const summary = serializeThread(base);
    expect(summary.readOnly).toBe(false);
    // Absent, not present-and-undefined: a key present at all would tell the
    // client there is something to switch on.
    expect(summary).not.toHaveProperty("readOnlyReason");
  });

  it("marks a thread read-only when its agent is archived", () => {
    expect(serializeThread({ ...base, agentArchivedAt: 123 })).toMatchObject({
      readOnly: true,
      readOnlyReason: "agent_deleted",
    });
  });

  it("marks a thread read-only when its agent is disabled", () => {
    expect(serializeThread({ ...base, agentEnabled: false })).toMatchObject({
      readOnly: true,
      readOnlyReason: "agent_disabled",
    });
  });

  it("treats an unjoined agent row as unknown, not as disabled", () => {
    const summary = serializeThread({ ...base, agentEnabled: null });
    expect(summary.readOnly).toBe(false);
    expect(summary).not.toHaveProperty("readOnlyReason");
  });

  it("keeps the archived-thread reason when both are true", () => {
    // The thread's own state outranks its agent's: unarchiving is a fix the
    // reader can perform, and naming the agent would be the wrong instruction.
    expect(
      serializeThread({ ...base, archivedAt: 9, agentArchivedAt: 123, agentEnabled: false }),
    ).toMatchObject({ readOnly: true, readOnlyReason: "thread_archived" });
  });

  it("keeps the legacy-runtime reason over a disabled agent", () => {
    expect(serializeThread({ ...base, runtime: "legacy", agentEnabled: false })).toMatchObject({
      readOnly: true,
      readOnlyReason: "legacy_runtime",
    });
  });

  it("still reports plain thread archival and legacy runtime", () => {
    expect(serializeThread({ ...base, archivedAt: 9 })).toMatchObject({
      readOnly: true,
      readOnlyReason: "thread_archived",
      status: "archived",
    });
    expect(serializeThread({ ...base, runtime: "legacy" })).toMatchObject({
      readOnly: true,
      readOnlyReason: "legacy_runtime",
      status: "active",
    });
  });
});
