import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import {
  stampToolCallDurations,
  toolCallIdsIn,
  wrapToolsWithTiming,
  type ToolCallTimingSink,
} from "../../../src/agent/tool-call-timing";

function recordingSink() {
  const events: string[] = [];
  const sink: ToolCallTimingSink = {
    start: ({ toolCallId, toolName, startedAt }) =>
      void events.push(`start:${toolName}:${toolCallId}:${startedAt}`),
    finish: ({ toolCallId, finishedAt, ok }) =>
      void events.push(`finish:${toolCallId}:${finishedAt}:${ok}`),
  };
  return { events, sink };
}

function clock(...values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe("wrapToolsWithTiming", () => {
  it("records start then finish around a successful call", async () => {
    const { events, sink } = recordingSink();
    const tools = {
      exec: { execute: async () => "ok" },
    } as unknown as ToolSet;

    const wrapped = wrapToolsWithTiming(tools, sink, clock(100, 450));
    const execute = wrapped.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>;
    await execute({}, { toolCallId: "call-1" });

    expect(events).toEqual(["start:exec:call-1:100", "finish:call-1:450:true"]);
  });

  it("leaves the tool's return value untouched", async () => {
    const { sink } = recordingSink();
    const output = { ok: true, nested: { deep: 1 } };
    const tools = { exec: { execute: async () => output } } as unknown as ToolSet;

    const wrapped = wrapToolsWithTiming(tools, sink);
    const execute = wrapped.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>;

    // Identity, not deep equality: the model's view of a tool result must be
    // byte-identical with and without timing.
    expect(await execute({}, { toolCallId: "c" })).toBe(output);
  });

  // A tool that fails slowly is exactly as interesting as one that succeeds
  // slowly, so the stamp lives in a `finally`.
  it("records a throwing call as finished and not ok, and rethrows", async () => {
    const { events, sink } = recordingSink();
    const boom = new Error("boom");
    const tools = {
      exec: {
        execute: async () => {
          throw boom;
        },
      },
    } as unknown as ToolSet;

    const wrapped = wrapToolsWithTiming(tools, sink, clock(0, 70));
    const execute = wrapped.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>;

    await expect(execute({}, { toolCallId: "c" })).rejects.toBe(boom);
    expect(events).toEqual(["start:exec:c:0", "finish:c:70:false"]);
  });

  // The open row must exist BEFORE the tool runs, or a call that never returns
  // leaves no evidence at all — the failure this whole feature exists for.
  it("opens the row before execute is entered", async () => {
    const { events, sink } = recordingSink();
    const tools = {
      exec: {
        execute: async () => {
          events.push("executing");
          return "ok";
        },
      },
    } as unknown as ToolSet;

    const wrapped = wrapToolsWithTiming(tools, sink);
    const execute = wrapped.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>;
    await execute({}, { toolCallId: "c" });

    expect(events[0]).toMatch(/^start:/);
    expect(events[1]).toBe("executing");
  });

  it("never records a finish for a call still in flight", async () => {
    const { events, sink } = recordingSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tools = { exec: { execute: () => gate } } as unknown as ToolSet;

    const wrapped = wrapToolsWithTiming(tools, sink);
    const execute = wrapped.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>;
    const pending = execute({}, { toolCallId: "c" });

    await Promise.resolve();
    expect(events).toEqual(["start:exec:c:" + events[0]!.split(":")[3]]);
    expect(events.some((e) => e.startsWith("finish"))).toBe(false);

    release();
    await pending;
    expect(events.some((e) => e.startsWith("finish"))).toBe(true);
  });

  it("passes through tools that have no execute", () => {
    const { sink } = recordingSink();
    const clientTool = { description: "client-resolved" };
    const wrapped = wrapToolsWithTiming({ ui: clientTool } as unknown as ToolSet, sink);
    expect(wrapped.ui).toBe(clientTool);
  });

  // Without an id there is nothing to key a row or a stamp on. Run the tool
  // rather than inventing an id that could never be joined back.
  it("runs untimed when no toolCallId is supplied", async () => {
    const { events, sink } = recordingSink();
    const execute = vi.fn(async () => "ok");
    const wrapped = wrapToolsWithTiming({ exec: { execute } } as unknown as ToolSet, sink);
    const wrappedExecute = wrapped.exec!.execute as (i: unknown, o: unknown) => Promise<unknown>;

    expect(await wrappedExecute({}, {})).toBe("ok");
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it("times every tool in the set, not only the first", async () => {
    const { events, sink } = recordingSink();
    const tools = {
      exec: { execute: async () => 1 },
      mcp_read: { execute: async () => 2 },
    } as unknown as ToolSet;

    const wrapped = wrapToolsWithTiming(tools, sink, clock(0, 1, 2, 3));
    for (const name of ["exec", "mcp_read"]) {
      const execute = wrapped[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>;
      await execute({}, { toolCallId: `${name}-call` });
    }

    expect(events.filter((e) => e.startsWith("start"))).toHaveLength(2);
    expect(events.some((e) => e.includes("mcp_read"))).toBe(true);
  });
});

describe("toolCallIdsIn", () => {
  it("collects ids from tool parts and ignores everything else", () => {
    const message = {
      parts: [
        { type: "text", text: "hi" },
        { type: "tool-exec", toolCallId: "a" },
        { type: "dynamic-tool", toolCallId: "b" },
        { type: "tool-broken", toolCallId: 7 },
      ],
    };
    expect(toolCallIdsIn(message)).toEqual(["a", "b"]);
  });

  it("returns nothing for a message with no parts", () => {
    expect(toolCallIdsIn({})).toEqual([]);
    expect(toolCallIdsIn(undefined)).toEqual([]);
  });
});

describe("stampToolCallDurations", () => {
  it("stamps durationMs onto matching tool parts", () => {
    const message = {
      parts: [
        { type: "text", text: "hi" },
        { type: "tool-exec", toolCallId: "a" },
        { type: "tool-exec", toolCallId: "b" },
      ],
    };
    stampToolCallDurations(message, new Map([["a", 2_600]]));

    expect(message.parts[1]).toMatchObject({ durationMs: 2_600 });
    // Threads predating this feature must render exactly as before: absence is
    // normal, not an error.
    expect(message.parts[2]).not.toHaveProperty("durationMs");
    expect(message.parts[0]).not.toHaveProperty("durationMs");
  });

  it("mutates in place and returns the same object", () => {
    const message = { parts: [{ type: "tool-exec", toolCallId: "a" }] };
    // In place because the caller hands us the very object about to be
    // persisted; a clone would stamp something the transcript never sees.
    expect(stampToolCallDurations(message, new Map([["a", 5]]))).toBe(message);
  });

  it("is a no-op with no durations", () => {
    const message = { parts: [{ type: "tool-exec", toolCallId: "a" }] };
    stampToolCallDurations(message, new Map());
    expect(message.parts[0]).not.toHaveProperty("durationMs");
  });

  it("tolerates a message with no parts", () => {
    expect(() => stampToolCallDurations({}, new Map([["a", 1]]))).not.toThrow();
  });
});
