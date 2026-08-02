import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { resolveContextBudget } from "../../../src/agent/context-budget";
import { capToolOutput, wrapToolsWithOutputCap } from "../../../src/agent/tool-output-cap";

describe("capToolOutput", () => {
  it("leaves small outputs untouched", () => {
    expect(capToolOutput("hello", 128_000)).toBe("hello");
    const obj = { a: 1, b: "small" };
    expect(capToolOutput(obj, 128_000)).toEqual(obj);
  });

  it("truncates a pathologically large string output, leaving a marker", () => {
    const out = capToolOutput("X".repeat(500_000), 1_000);

    expect(typeof out).toBe("string");
    expect((out as string).length).toBeLessThan(3_000);
    expect(out as string).toContain("truncated");
  });

  it("keeps container shape when truncating a large structured output", () => {
    const out = capToolOutput({ log: "Y".repeat(500_000) }, 1_000);

    expect(JSON.stringify(out)).toContain("truncated");
  });
});

describe("wrapToolsWithOutputCap", () => {
  it("caps a tool's oversized execute result", async () => {
    const tools = {
      exec: {
        description: "run",
        inputSchema: {},
        execute: async () => "Z".repeat(500_000),
      },
    } as unknown as ToolSet;

    const wrapped = wrapToolsWithOutputCap(tools, 1_000);
    const result = await wrapped.exec!.execute!({}, { toolCallId: "c1", messages: [] });

    expect(String(result).length).toBeLessThan(3_000);
    expect(String(result)).toContain("truncated");
  });

  it("leaves a small execute result untouched", async () => {
    const tools = {
      ping: { description: "ping", inputSchema: {}, execute: async () => "pong" },
    } as unknown as ToolSet;

    const wrapped = wrapToolsWithOutputCap(tools, 1_000);

    expect(await wrapped.ping!.execute!({}, { toolCallId: "c1", messages: [] })).toBe("pong");
  });

  it("passes through tools without execute and preserves other props", () => {
    const tools = { clientTool: { description: "client", inputSchema: {} } } as unknown as ToolSet;

    const wrapped = wrapToolsWithOutputCap(tools, 1_000);

    expect(wrapped.clientTool!.description).toBe("client");
    expect(wrapped.clientTool!.execute).toBeUndefined();
  });

  it("caps a tool output tighter on a small-window model than a large one", async () => {
    const huge = "z".repeat(500_000);
    const tools = { probe: { execute: async () => huge } } as never;

    const small = resolveContextBudget(32_000).maxToolOutputCapChars;
    const large = resolveContextBudget(200_000).maxToolOutputCapChars;
    expect(small).toBeLessThan(large);

    const wrapped = wrapToolsWithOutputCap(tools, small);
    const output = await (
      wrapped as unknown as {
        probe: { execute: (i: unknown, o: unknown) => Promise<unknown> };
      }
    ).probe.execute({}, {});

    expect(String(output).length).toBeLessThanOrEqual(small);
  });
});
