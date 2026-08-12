import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  NADI_WATCHER_COMPLETION_KIND,
  isWatcherCompletionMessage,
  parseWatcherCompletion,
  watcherResultModel,
  type WatcherCompletionInfo,
} from "./watcher-runs";

const completionMessage = (watcher: unknown): UIMessage => ({
  id: "sysrem_1",
  role: "user",
  parts: [{ type: "text", text: "<system-reminder>\nx\n</system-reminder>" }],
  metadata: { nadiKind: NADI_WATCHER_COMPLETION_KIND, watcher },
});

describe("parseWatcherCompletion", () => {
  it("extracts the structured facts from watcher-completion metadata", () => {
    const info: WatcherCompletionInfo = {
      title: "build",
      command: "pnpm build",
      outcome: "exited",
      exitCode: 0,
      outputTail: "done\n",
    };
    expect(parseWatcherCompletion(completionMessage(info))).toEqual(info);
  });

  it("returns null for a message without the watcher-completion kind", () => {
    expect(
      parseWatcherCompletion({
        id: "m",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { nadiKind: "system-reminder" },
      }),
    ).toBeNull();
    expect(
      parseWatcherCompletion({ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }),
    ).toBeNull();
  });

  it("returns null when the watcher payload is missing or malformed", () => {
    expect(parseWatcherCompletion(completionMessage(undefined))).toBeNull();
    expect(parseWatcherCompletion(completionMessage("not-an-object"))).toBeNull();
  });

  it("coerces a missing exit code to null and omits an absent output tail", () => {
    const info = parseWatcherCompletion(
      completionMessage({ title: "t", command: "cmd", outcome: "exited" }),
    );
    expect(info).toEqual({ title: "t", command: "cmd", outcome: "exited", exitCode: null });
    expect(info?.outputTail).toBeUndefined();
  });

  it("isWatcherCompletionMessage keys on the marker, not on parse success", () => {
    // A well-formed completion is recognized...
    expect(
      isWatcherCompletionMessage(completionMessage({ command: "c", outcome: "timeout" })),
    ).toBe(true);
    // ...and so is a message that carries the kind marker but a malformed
    // payload — so ChatLog routes it to the card branch (which degrades) rather
    // than letting it fall through and leak raw <system-reminder> text.
    expect(isWatcherCompletionMessage(completionMessage("not-an-object"))).toBe(true);
    expect(parseWatcherCompletion(completionMessage("not-an-object"))).toBeNull();
    // Non-watcher messages are not recognized.
    expect(
      isWatcherCompletionMessage({ id: "m", role: "user", parts: [{ type: "text", text: "x" }] }),
    ).toBe(false);
    expect(
      isWatcherCompletionMessage({
        id: "m",
        role: "user",
        parts: [{ type: "text", text: "x" }],
        metadata: { nadiKind: "system-reminder" },
      }),
    ).toBe(false);
  });
});

describe("watcherResultModel", () => {
  const base = (over: Partial<WatcherCompletionInfo>): WatcherCompletionInfo => ({
    title: "build",
    command: "pnpm build",
    outcome: "exited",
    exitCode: 0,
    ...over,
  });

  it("renders a clean exit as success with the exit code and output tail", () => {
    const model = watcherResultModel(base({ exitCode: 0, outputTail: "compiled\n" }));
    expect(model).toEqual({
      title: "build",
      statusLabel: "exited · code 0",
      tone: "success",
      body: "compiled\n",
    });
  });

  it("renders a non-zero exit as an error tone", () => {
    const model = watcherResultModel(base({ exitCode: 1, outputTail: "boom" }));
    expect(model.tone).toBe("error");
    expect(model.statusLabel).toBe("exited · code 1");
  });

  it("labels an unknown exit code without a code suffix", () => {
    const model = watcherResultModel(base({ exitCode: null }));
    expect(model.statusLabel).toBe("exited");
    expect(model.tone).toBe("error");
  });

  it("falls back to a placeholder body when there is no output", () => {
    expect(watcherResultModel(base({ exitCode: 0, outputTail: "   " })).body).toBe("(no output)");
    expect(watcherResultModel(base({ exitCode: 0 })).body).toBe("(no output)");
  });

  it("renders a timeout as a stopped tone with its own copy", () => {
    const model = watcherResultModel(base({ outcome: "timeout", exitCode: null }));
    expect(model.tone).toBe("stopped");
    expect(model.statusLabel).toBe("timed out");
    expect(model.body).toMatch(/watch timeout/);
  });

  // A fault is a FAILURE, not a neutral "we stopped watching": the process is
  // gone without ever reaching a real terminal. It gets the reject intent, not
  // the timeout's softer tone.
  it("renders a fault with the reject (error) intent, not the timeout tone", () => {
    const model = watcherResultModel(base({ outcome: "fault", exitCode: null }));
    expect(model.tone).toBe("fault");
    expect(model.statusLabel).toBe("faulted");
    expect(model.body).toMatch(/reached a terminal|no terminal|torn down|gone/i);
  });

  // A reset and a tear-down are both `fault`, but they cost the human
  // different things — the sandbox_reset card must say the FILES are gone, not
  // just that a process is.
  it("tells a sandbox reset apart from a plain fault", () => {
    const reset = watcherResultModel(
      base({ outcome: "fault", reason: "sandbox_reset", exitCode: null }),
    );
    expect(reset.tone).toBe("fault");
    expect(reset.statusLabel).toBe("sandbox reset");
    expect(reset.body).toMatch(/file/i);

    const torndown = watcherResultModel(
      base({ outcome: "fault", reason: "no_liveness", exitCode: null }),
    );
    expect(torndown.statusLabel).toBe("faulted");
    expect(torndown.body).not.toBe(reset.body);
  });

  // Older payloads carry no reason; the card must degrade to generic fault
  // copy rather than claiming a reset that may not have happened.
  it("falls back to generic fault copy when the reason is absent or unknown", () => {
    expect(watcherResultModel(base({ outcome: "fault", exitCode: null })).statusLabel).toBe(
      "faulted",
    );
    expect(
      parseWatcherCompletion(
        completionMessage({ title: "t", command: "c", outcome: "fault", reason: "wat" }),
      )?.reason,
    ).toBeUndefined();
    expect(
      parseWatcherCompletion(
        completionMessage({ title: "t", command: "c", outcome: "fault", reason: "sandbox_reset" }),
      )?.reason,
    ).toBe("sandbox_reset");
  });

  it("renders a stopped process as stopped, never as an exit", () => {
    const model = watcherResultModel(base({ outcome: "stopped", exitCode: null }));
    expect(model.tone).toBe("stopped");
    expect(model.statusLabel).toBe("stopped");
    expect(model.statusLabel).not.toMatch(/exited/);
  });

  // The card is fed from message metadata written by an older/newer server, so
  // an unrecognized outcome must not silently render as a clean exit.
  it("parseWatcherCompletion keeps every known outcome and falls back to exited", () => {
    for (const outcome of ["exited", "timeout", "fault", "stopped"] as const) {
      expect(
        parseWatcherCompletion(completionMessage({ title: "t", command: "c", outcome }))?.outcome,
      ).toBe(outcome);
    }
    expect(
      parseWatcherCompletion(
        completionMessage({ title: "t", command: "c", outcome: "nonsense" } as never),
      )?.outcome,
    ).toBe("exited");
  });
});
