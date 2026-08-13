import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  SUBAGENT_NOTIFY_SOURCE,
  isSubagentCompletionMessage,
  parseSubagentCompletion,
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

describe("interrupted run rendering", () => {
  it("subagentResultModel surfaces reason on an interrupted joined run", () => {
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

describe("SUBAGENT_COMPLETION_RE quote tolerance", () => {
  /**
   * The actual production bug: a label containing embedded double quotes (the
   * observed one contained `the project "Markdump"`, via the now-fixed
   * `label ?? task` fallback making the whole task brief the label) could not
   * match a strict `"([^"]*)"` capture at all, so the message fell back to a
   * raw text bubble instead of a result card. `formatSubagentCompletion` now
   * strips `"` from the label server-side, but this proves the CLIENT side is
   * independently robust too — this regex has broken twice, so both ends are
   * now defensive rather than relying on the other to always sanitize first.
   */
  it("still parses a completion whose label contains embedded double quotes", () => {
    const text =
      '<system-reminder>\nSubagent "the project "Markdump"" finished: completed. [sub_1]\nDone.\n</system-reminder>';
    const message = userMsg(text);
    expect(isSubagentCompletionMessage(message)).toBe(true);
    const parsed = parseSubagentCompletion(message);
    expect(parsed?.label).toBe('the project "Markdump"');
    expect(parsed?.status).toBe("completed");
    expect(parsed?.runId).toBe("sub_1");
    expect(parsed?.body).toBe("Done.");
  });

  it("still matches the plain (already-sanitized) label shape", () => {
    expect(isSubagentCompletionMessage(completion({ label: "Repo scan" }))).toBe(true);
  });
});
