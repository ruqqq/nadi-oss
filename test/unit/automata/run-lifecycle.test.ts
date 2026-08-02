import { describe, expect, it } from "vitest";
import { transitionFor } from "../../../src/automata/run-lifecycle";

describe("transitionFor", () => {
  it("starts a queued run and records startedAt", () => {
    expect(transitionFor({ type: "thread.started", startedAt: 1000 })).toEqual({
      from: ["queued"],
      patch: { status: "running", startedAt: 1000 },
    });
  });

  it("only starts from queued, so a second turn cannot restart the clock", () => {
    expect(transitionFor({ type: "thread.started", startedAt: 1 }).from).toEqual(["queued"]);
  });

  it("completes only from a non-terminal state, so a later reply cannot reopen the run", () => {
    const { from, patch } = transitionFor({ type: "thread.completed", occurredAt: 2000 });
    expect(from).toEqual(["queued", "running"]);
    expect(from).not.toContain("completed");
    expect(from).not.toContain("waiting_for_approval");
    expect(patch).toEqual({ status: "completed", finishedAt: 2000 });
  });

  it("treats attention_required as terminal and records no finishedAt", () => {
    expect(transitionFor({ type: "thread.attention_required", occurredAt: 2000 })).toEqual({
      from: ["queued", "running"],
      patch: { status: "waiting_for_approval" },
    });
  });

  it("fails only from a non-terminal state", () => {
    const { from, patch } = transitionFor({ type: "thread.failed", occurredAt: 2000 });
    expect(from).toEqual(["queued", "running"]);
    expect(patch).toEqual({ status: "failed", finishedAt: 2000 });
  });

  it("stores a blocked reason on the run when attention is required", () => {
    const { from, patch } = transitionFor({
      type: "thread.attention_required",
      occurredAt: 1,
      reason: "Foo MCP not configured",
    });
    expect(from).toEqual(["queued", "running"]);
    expect(patch).toMatchObject({
      status: "waiting_for_approval",
      error: "Foo MCP not configured",
    });
  });

  it("omits error when no reason is given (tool-approval pause)", () => {
    const { patch } = transitionFor({ type: "thread.attention_required", occurredAt: 1 });
    expect(patch).toEqual({ status: "waiting_for_approval" });
  });

  it("stores a failed reason", () => {
    const { patch } = transitionFor({ type: "thread.failed", occurredAt: 2, reason: "boom" });
    expect(patch).toMatchObject({ status: "failed", error: "boom", finishedAt: 2 });
  });
});
