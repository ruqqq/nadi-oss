import { describe, expect, it, vi } from "vitest";
import {
  buildAutomatonRunMessage,
  runAutomatonTurn,
  type AutomatonRunPort,
} from "../../../src/agent/automaton-run";

// `runAutomatonTurn` is the exact logic behind ThinkThreadAgent.beginAutomatonRun,
// extracted into a pure function tested against a port double. Importing
// ThinkThreadAgent directly pulls in `agents` -> `cloudflare:workers`, which the
// node-environment `unit` vitest project cannot resolve, so the class itself
// cannot be instantiated (even via Object.create(...prototype)) in this project.
function portDouble() {
  const submitted: unknown[][] = [];
  const port: AutomatonRunPort = {
    assertThreadWritable: vi.fn().mockResolvedValue(undefined),
    submitMessages: vi.fn(async (messages) => {
      submitted.push(messages);
    }),
    serializeQueuedRpc: (run) => run(),
  };
  return { port, submitted };
}

describe("buildAutomatonRunMessage", () => {
  it("builds an ordinary visible user message with no metadata", () => {
    const message = buildAutomatonRunMessage("Give me my briefing.");
    expect(message.role).toBe("user");
    expect(message.parts).toEqual([{ type: "text", text: "Give me my briefing." }]);
    // A hidden system-reminder would be invisible in the thread. It must not be one.
    expect((message as { metadata?: unknown }).metadata).toBeUndefined();
    expect(message.id).toMatch(/^amsg_/);
  });
});

describe("runAutomatonTurn", () => {
  it("submits the prompt as an ordinary visible user message", async () => {
    const { port, submitted } = portDouble();
    await runAutomatonTurn(port, "Give me my briefing.");
    expect(port.assertThreadWritable).toHaveBeenCalledTimes(1);
    const [message] = submitted[0] as [{ role: string; parts: unknown[]; metadata?: unknown }];
    expect(message.role).toBe("user");
    expect(message.parts).toEqual([{ type: "text", text: "Give me my briefing." }]);
    expect(message.metadata).toBeUndefined();
  });

  it("refuses to run against a thread that is not writable", async () => {
    const { port, submitted } = portDouble();
    port.assertThreadWritable = vi.fn().mockRejectedValue(new Error("thread_archived"));
    await expect(runAutomatonTurn(port, "x")).rejects.toThrow(/thread_archived/);
    expect(submitted).toHaveLength(0);
  });
});
