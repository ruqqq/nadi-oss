import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  SUBAGENT_NOTIFY_SOURCE,
  effectiveRunTiming,
  formatElapsed,
  isSubagentCompletionMessage,
  parseSubagentCompletion,
  runDurationLabel,
  subagentCardModel,
  subagentCardTitle,
  subagentResultModel,
  subagentTone,
  type SubagentRunView,
} from "./subagent-runs";

// Mirrors the backend `formatSubagentCompletion` string exactly — this is what
// the client actually receives (a role:"user" message; the notify metadata is
// NOT on the message, so detection is by text shape).
const completion = (
  opts: { label?: string | null; status?: string; runId?: string; body?: string } = {},
): UIMessage => {
  const status = opts.status ?? "completed";
  const runId = opts.runId ?? "sub_1";
  const body = opts.body ?? "Done.";
  const head = opts.label === null ? "(unlabeled)" : `"${opts.label ?? "Sleep test"}"`;
  const text = `<system-reminder>\nSubagent ${head} finished: ${status}. [${runId}]\n${body}\n</system-reminder>`;
  return { id: "c1", role: "user", parts: [{ type: "text", text }] };
};

const userMsg = (text: string): UIMessage => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text }],
});

const run = (over: Partial<SubagentRunView> = {}): SubagentRunView => ({
  runId: "sub_1",
  status: "running",
  ...over,
});

describe("SUBAGENT_NOTIFY_SOURCE", () => {
  it("matches the backend detached.notify.source", () => {
    expect(SUBAGENT_NOTIFY_SOURCE).toBe("subagent");
  });
});

describe("isSubagentCompletionMessage", () => {
  it("recognizes a labeled and an unlabeled subagent completion by text shape", () => {
    expect(isSubagentCompletionMessage(completion())).toBe(true);
    expect(isSubagentCompletionMessage(completion({ label: null }))).toBe(true);
  });
  it("ignores other messages", () => {
    expect(isSubagentCompletionMessage(userMsg("just a normal message"))).toBe(false);
    // A non-subagent system-reminder must not match.
    expect(
      isSubagentCompletionMessage(userMsg("<system-reminder>\nsomething else\n</system-reminder>")),
    ).toBe(false);
    // Same text but wrong role (assistant) must not match.
    expect(
      isSubagentCompletionMessage({
        id: "a1",
        role: "assistant",
        parts: completion().parts,
      }),
    ).toBe(false);
  });
});

describe("parseSubagentCompletion", () => {
  it("extracts label, status, runId, and body", () => {
    expect(
      parseSubagentCompletion(
        completion({
          label: "Repo scan",
          status: "completed",
          runId: "sub_9",
          body: "Found 3 bugs",
        }),
      ),
    ).toEqual({ label: "Repo scan", status: "completed", runId: "sub_9", body: "Found 3 bugs" });
  });
  it("omits the label for an unlabeled run", () => {
    const parsed = parseSubagentCompletion(completion({ label: null, runId: "sub_2" }));
    expect(parsed?.label).toBeUndefined();
    expect(parsed?.runId).toBe("sub_2");
  });
  it("returns null for a non-completion message", () => {
    expect(parseSubagentCompletion(userMsg("hello"))).toBeNull();
  });
});

describe("subagentTone", () => {
  it("maps statuses to tones", () => {
    expect(subagentTone("running")).toBe("running");
    expect(subagentTone("completed")).toBe("success");
    expect(subagentTone("error")).toBe("error");
    expect(subagentTone("aborted")).toBe("stopped");
    expect(subagentTone("interrupted")).toBe("stopped");
  });
});

describe("subagentCardTitle", () => {
  it("prefers the display name", () => {
    expect(subagentCardTitle(run({ display: { name: "Repo scan" } }))).toBe("Repo scan");
  });
  it("falls back to a truncated inputPreview, then to 'Subagent'", () => {
    expect(subagentCardTitle(run({ inputPreview: "a".repeat(100) }))).toBe(`${"a".repeat(80)}…`);
    expect(subagentCardTitle(run())).toBe("Subagent");
  });
});

describe("formatElapsed", () => {
  it("formats seconds and minutes", () => {
    expect(formatElapsed(4200)).toBe("4s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(-10)).toBe("0s");
  });
});

describe("subagentCardModel", () => {
  it("derives status, progress line, and elapsed", () => {
    const model = subagentCardModel(
      run({ status: "running", progress: { message: "sleeping" }, display: { name: "Sleep" } }),
      { firstSeenMs: 1000, nowMs: 6000 },
    );
    expect(model).toMatchObject({
      title: "Sleep",
      tone: "running",
      isRunning: true,
      progressLine: "sleeping",
      elapsedLabel: "5s",
    });
  });
  it("uses phase when message is absent and omits elapsed without a first-seen", () => {
    const model = subagentCardModel(run({ progress: { phase: "working" } }), { nowMs: 6000 });
    expect(model.progressLine).toBe("working");
    expect(model.elapsedLabel).toBeUndefined();
  });
});

describe("runDurationLabel", () => {
  it("uses server startedAt for a running run (survives refresh)", () => {
    expect(runDurationLabel({ startedAt: 1_000, nowMs: 61_000 })).toBe(formatElapsed(60_000));
  });
  it("freezes at finishedAt for a terminal run", () => {
    expect(runDurationLabel({ startedAt: 1_000, finishedAt: 31_000, nowMs: 999_999 })).toBe(
      formatElapsed(30_000),
    );
  });
  it("is undefined without a start timestamp", () => {
    expect(runDurationLabel({ nowMs: 5_000 })).toBeUndefined();
  });
});

describe("interrupted run rendering", () => {
  it("renders a distinct statusLabel from a clean completed run, surfacing reason/childStillRunning", () => {
    const interrupted = subagentCardModel(
      run({
        status: "interrupted",
        reason: "budget-exceeded",
        childStillRunning: true,
        display: { name: "Repo scan" },
      }),
      { nowMs: 6000 },
    );
    const completed = subagentCardModel(
      run({ status: "completed", display: { name: "Repo scan" } }),
      {
        nowMs: 6000,
      },
    );
    expect(interrupted.statusLabel).not.toBe(completed.statusLabel);
    expect(interrupted.statusLabel).toContain("budget-exceeded");
    expect(interrupted.statusLabel.toLowerCase()).toContain("still running");
  });

  it("subagentResultModel also surfaces reason on an interrupted joined run", () => {
    const model = subagentResultModel(completion({ runId: "sub_1", status: "interrupted" }), {
      sub_1: run({ status: "interrupted", reason: "no-progress", childStillRunning: false }),
    });
    expect(model.statusLabel).toContain("no-progress");
    expect(model.statusLabel).not.toBe("Interrupted");
  });
});

describe("subagentResultModel", () => {
  it("prefers the joined run's summary and name (correlated by parsed runId)", () => {
    const model = subagentResultModel(completion({ runId: "sub_1", status: "completed" }), {
      sub_1: run({ status: "completed", display: { name: "Repo scan" }, summary: "Found 3 bugs" }),
    });
    expect(model).toMatchObject({ title: "Repo scan", tone: "success", body: "Found 3 bugs" });
  });
  it("falls back to the parsed label/body/status when the run is absent", () => {
    const model = subagentResultModel(
      completion({ label: "X", runId: "gone", status: "completed", body: "All done" }),
      {},
    );
    expect(model).toMatchObject({ title: "X", tone: "success", body: "All done" });
    expect(model.body).not.toContain("<system-reminder>");
  });
  it("prefers the run's error over its summary", () => {
    const model = subagentResultModel(completion({ runId: "sub_1", status: "error" }), {
      sub_1: run({ status: "error", summary: "did stuff", error: "boom" }),
    });
    expect(model).toMatchObject({ body: "boom", tone: "error" });
  });
  it("degrades gracefully on an unknown parsed status with no joined run", () => {
    const model = subagentResultModel(completion({ status: "mystery", runId: "gone" }), {});
    expect(model.tone).toBe("success");
  });
});

describe("effectiveRunTiming", () => {
  it("prefers the server finishedAt over the client terminal fallback", () => {
    const t = effectiveRunTiming({ startedAt: 1000, finishedAt: 5000 }, 9000);
    expect(t).toEqual({ startedAt: 1000, finishedAt: 5000 });
  });

  it("falls back to the client terminal timestamp when finishedAt is missing", () => {
    const t = effectiveRunTiming({ startedAt: 1000 }, 4000);
    expect(t).toEqual({ startedAt: 1000, finishedAt: 4000 });
    // The fallback is what stops runDurationLabel from tracking the live clock.
    expect(runDurationLabel({ ...t, nowMs: 99999 })).toBe(runDurationLabel({ ...t, nowMs: 4000 }));
  });

  it("emits no finishedAt when neither source has one (still running)", () => {
    expect(effectiveRunTiming({ startedAt: 1000 }, undefined)).toEqual({ startedAt: 1000 });
  });

  it("tolerates undefined server timing", () => {
    expect(effectiveRunTiming(undefined, 4000)).toEqual({ finishedAt: 4000 });
    expect(effectiveRunTiming(undefined, undefined)).toEqual({});
  });
});
