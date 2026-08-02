/**
 * Unit test: streamText + needsApproval HITL mechanism.
 *
 * Uses MockLanguageModelV3 from ai/test to emit a tool call, then asserts:
 *   - approval_required: execute NOT called; stream contains tool-approval-request chunk
 *   - auto_allow: execute IS called; stream contains tool-output-available chunk
 *
 * Runs in Node environment (not CF workers pool) because importing ai/test
 * directly in a miniflare worker test crashes the worker. The source-level
 * import (model-factory.ts) works because it is bundled as worker code;
 * the test-file-level import does not survive miniflare's module graph.
 */
import { tool, streamText, stepCountIs, type UIMessageChunk } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { wrapToolsWithPolicy } from "../../../src/mcp/policy";

/** Build a mock model that emits exactly one tool-call for the given tool. */
function makeToolCallModel(toolName: string, inputJson: string) {
  return new MockLanguageModelV3({
    provider: "mock",
    modelId: "mock",
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: [
          {
            type: "tool-call" as const,
            toolCallId: "tc-1",
            toolName,
            input: inputJson,
          },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

/** Consume a UIMessageStream and collect chunks. */
async function collectChunks(result: ReturnType<typeof streamText>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of result.toUIMessageStream()) {
    chunks.push(chunk as UIMessageChunk);
  }
  return chunks;
}

describe("streamText + needsApproval (HITL approval mechanism)", () => {
  it("approval_required: execute is NOT called; stream has tool-approval-request", async () => {
    const executeSpy = vi.fn().mockResolvedValue("should-not-run");

    const baseTool = tool({
      description: "Sensitive operation",
      inputSchema: z.object({ action: z.string() }),
      execute: executeSpy,
    });

    const policyTools = wrapToolsWithPolicy({ sensitiveOp: baseTool }, () => "approval_required");

    const model = makeToolCallModel("sensitiveOp", '{"action":"delete"}');

    const result = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: "Run sensitive op",
      tools: policyTools,
      experimental_toolApprovalSecret: "test-secret",
      // Safety cap: stop after 1 step in case approval-pause doesn't halt the loop
      stopWhen: stepCountIs(1),
    });

    const chunks = await collectChunks(result);
    const types = chunks.map((c) => c.type);

    // Stream must contain the approval-request signal
    expect(types).toContain("tool-approval-request");

    // Output must NOT appear (execute was blocked by needsApproval)
    expect(types).not.toContain("tool-output-available");

    // Execute must NOT have been called
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("auto_allow: execute IS called; stream has tool-output-available", async () => {
    const executeSpy = vi.fn().mockResolvedValue("tool-result-value");

    const baseTool = tool({
      description: "Safe operation",
      inputSchema: z.object({ action: z.string() }),
      execute: executeSpy,
    });

    const policyTools = wrapToolsWithPolicy({ safeOp: baseTool }, () => "auto_allow");

    const model = makeToolCallModel("safeOp", '{"action":"list"}');

    const result = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: "Run safe op",
      tools: policyTools,
      experimental_toolApprovalSecret: "test-secret",
      // Stop after 1 step to prevent re-calling the tool-emitting mock indefinitely
      stopWhen: stepCountIs(1),
    });

    const chunks = await collectChunks(result);
    const types = chunks.map((c) => c.type);

    // Execute must have been called
    expect(executeSpy).toHaveBeenCalledWith({ action: "list" }, expect.anything());

    // Stream must contain tool-output-available
    expect(types).toContain("tool-output-available");

    // No approval request should appear
    expect(types).not.toContain("tool-approval-request");
  });
});
