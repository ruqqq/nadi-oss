import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { completionLineModel, subagentResultsByRunId } from "./completion-line";
import { NADI_WATCHER_COMPLETION_KIND } from "./watcher-runs";
import type { SubagentRunView } from "./subagent-runs";

const watcherMessage = (watcher: unknown): UIMessage => ({
  id: "sysrem_1",
  role: "user",
  parts: [{ type: "text", text: "<system-reminder>\nx\n</system-reminder>" }],
  metadata: { nadiKind: NADI_WATCHER_COMPLETION_KIND, watcher },
});

/** The exact shape `formatSubagentCompletion` emits (src/agent/subagent-tools.ts). */
const subagentMessage = (
  label: string,
  status: string,
  runId: string,
  body: string,
): UIMessage => ({
  id: `m_${runId}`,
  role: "user",
  parts: [
    {
      type: "text",
      text: `<system-reminder>\nSubagent "${label}" finished: ${status}. [${runId}]\n${body}\n</system-reminder>`,
    },
  ],
});

const text = (model: { segments: { text: string }[] }) =>
  model.segments.map((s) => s.text).join(" ");

describe("completionLineModel — subagent", () => {
  it("leads with a verb phrase and puts the name second, faint", () => {
    const model = completionLineModel(
      subagentMessage("Eight checks", "completed", "sub_1", "ok"),
      {},
    );
    expect(model).not.toBeNull();
    expect(text(model!)).toBe("Subagent finished · Eight checks");
    // The name is the faint half — the run log's grammar, not a second heading.
    expect(model!.segments[1]?.tone).toBe("faint");
    expect(model!.title).toBe("Eight checks");
    expect(model!.body).toBe("ok");
  });

  it("is silent on success and marked on failure", () => {
    const ok = completionLineModel(subagentMessage("a", "completed", "sub_1", "done"), {});
    const bad = completionLineModel(subagentMessage("a", "error", "sub_2", "boom"), {});
    // `idle` is what makes ActivityLine render no glyph at all.
    expect(ok!.state).toBe("idle");
    expect(ok!.tone).toBe("ok");
    expect(bad!.state).toBe("error");
    expect(bad!.tone).toBe("bad");
    expect(text(bad!)).toBe("Subagent failed · a");
  });

  it("takes the word for a stopped run from its status, not a flattened label", () => {
    // Cancelled and interrupted read very differently to whoever is looking, so
    // the phrase must not collapse both to one word.
    const aborted = completionLineModel(subagentMessage("a", "aborted", "sub_1", ""), {});
    const interrupted = completionLineModel(subagentMessage("a", "interrupted", "sub_2", ""), {});
    expect(text(aborted!)).toBe("Subagent cancelled · a");
    expect(text(interrupted!)).toBe("Subagent interrupted · a");
  });

  it("prefers the live run's name and status over the message text", () => {
    const runs: Record<string, SubagentRunView> = {
      sub_1: { runId: "sub_1", status: "error", display: { name: "Live name" }, error: "it broke" },
    };
    const model = completionLineModel(
      subagentMessage("Stale name", "completed", "sub_1", "x"),
      runs,
    );
    expect(text(model!)).toBe("Subagent failed · Live name");
    expect(model!.body).toBe("it broke");
  });

  it("returns null for a message that is neither kind", () => {
    expect(
      completionLineModel({ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }, {}),
    ).toBeNull();
  });
});

describe("completionLineModel — process", () => {
  it("says finished, not 'exited code 0', for a clean exit", () => {
    const model = completionLineModel(
      watcherMessage({ title: "build", command: "pnpm build", outcome: "exited", exitCode: 0 }),
      {},
    );
    expect(text(model!)).toBe("Process finished · build");
    expect(model!.state).toBe("idle");
    // The command is the mono half — it is a command, not prose.
    expect(model!.segments[1]?.mono).toBe(true);
  });

  it("names the code on a non-zero exit and marks the line", () => {
    const model = completionLineModel(
      watcherMessage({ title: "build", command: "pnpm build", outcome: "exited", exitCode: 7 }),
      {},
    );
    expect(text(model!)).toBe("Process exited 7 · build");
    expect(model!.state).toBe("error");
    expect(model!.tone).toBe("bad");
  });

  it("carries the ledger's own word for a non-exit outcome", () => {
    const timedOut = completionLineModel(
      watcherMessage({ title: "build", command: "c", outcome: "timeout", exitCode: null }),
      {},
    );
    const reset = completionLineModel(
      watcherMessage({
        title: "build",
        command: "c",
        outcome: "fault",
        reason: "sandbox_reset",
        exitCode: null,
      }),
      {},
    );
    expect(text(timedOut!)).toBe("Process timed out · build");
    expect(text(reset!)).toBe("Process sandbox reset · build");
    expect(reset!.state).toBe("error");
  });

  it("still renders a line when the payload is unparseable", () => {
    // The old card returned null here, dropping the completion from the
    // transcript entirely. A nameless line beats a hole.
    const model = completionLineModel(watcherMessage(undefined), {});
    expect(model).not.toBeNull();
    expect(model!.kind).toBe("process");
    expect(text(model!)).toBe("Process finished");
  });
});

describe("subagentResultsByRunId", () => {
  it("keys each subagent completion by its run id", () => {
    const map = subagentResultsByRunId(
      [
        subagentMessage("first", "completed", "sub_1", "one"),
        { id: "chat", role: "assistant", parts: [{ type: "text", text: "hello" }] },
        subagentMessage("second", "error", "sub_2", "two"),
      ],
      {},
    );
    expect(Object.keys(map).sort()).toEqual(["sub_1", "sub_2"]);
    expect(map.sub_1?.body).toBe("one");
    expect(map.sub_2?.tone).toBe("bad");
  });

  it("omits process completions — the sheet reads their output live instead", () => {
    const map = subagentResultsByRunId(
      [watcherMessage({ title: "build", command: "c", outcome: "exited", exitCode: 0 })],
      {},
    );
    expect(map).toEqual({});
  });

  it("has no entry for a run whose completion is not in the transcript", () => {
    // Compaction. The sheet must render NO disclosure for this row rather than
    // an empty one, which would claim the run returned nothing.
    const map = subagentResultsByRunId([subagentMessage("a", "completed", "sub_1", "x")], {});
    expect(map.sub_2).toBeUndefined();
  });
});
