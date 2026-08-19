import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  effectiveModelSwitchRequest,
  modelSwitchRequestFromMessage,
  readModelSwitchRequest,
} from "../../../src/agent/model-switch-request";

function userMessage(id: string, metadata?: unknown): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: id }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("readModelSwitchRequest", () => {
  it("parses a full request", () => {
    expect(
      readModelSwitchRequest({
        provider: "mock-tool-call",
        model: "mock-model-2",
        modelInputModalities: ["text", "image"],
        modelSupportsReasoning: true,
      }),
    ).toEqual({
      provider: "mock-tool-call",
      model: "mock-model-2",
      modelInputModalities: ["text", "image"],
      modelSupportsReasoning: true,
    });
  });

  it("parses a bare provider+model request, both optionals omitted", () => {
    expect(readModelSwitchRequest({ provider: "mock-tool-call", model: "mock-model-2" })).toEqual({
      provider: "mock-tool-call",
      model: "mock-model-2",
    });
  });

  it("degrades to null for a non-object value", () => {
    expect(readModelSwitchRequest(null)).toBeNull();
    expect(readModelSwitchRequest(undefined)).toBeNull();
    expect(readModelSwitchRequest("not-an-object")).toBeNull();
    expect(readModelSwitchRequest(42)).toBeNull();
  });

  it("degrades to null for an unsupported provider", () => {
    expect(readModelSwitchRequest({ provider: "not-a-real-provider", model: "x" })).toBeNull();
  });

  it("degrades to null for a missing/empty model", () => {
    expect(readModelSwitchRequest({ provider: "mock-tool-call" })).toBeNull();
    expect(readModelSwitchRequest({ provider: "mock-tool-call", model: "" })).toBeNull();
  });

  it("degrades to null for an invalid modelInputModalities", () => {
    expect(
      readModelSwitchRequest({
        provider: "mock-tool-call",
        model: "x",
        modelInputModalities: ["not-a-real-modality"],
      }),
    ).toBeNull();
  });

  it("degrades to null for a non-boolean modelSupportsReasoning", () => {
    expect(
      readModelSwitchRequest({
        provider: "mock-tool-call",
        model: "x",
        modelSupportsReasoning: "yes",
      }),
    ).toBeNull();
  });

  it("degrades to null for a metadata object belonging to something else entirely", () => {
    // e.g. a steered-message or system-reminder marker — no `provider`/`model`
    // at all, must never be misread as a switch request.
    expect(readModelSwitchRequest({ nadiKind: "steered" })).toBeNull();
  });
});

describe("modelSwitchRequestFromMessage", () => {
  it("reads the request straight off a message's metadata", () => {
    expect(
      modelSwitchRequestFromMessage(
        userMessage("u1", { provider: "mock-tool-call", model: "mock-model-2" }),
      ),
    ).toEqual({ provider: "mock-tool-call", model: "mock-model-2" });
  });

  it("null when the message carries no metadata", () => {
    expect(modelSwitchRequestFromMessage(userMessage("u1"))).toBeNull();
  });
});

describe("effectiveModelSwitchRequest", () => {
  it("null on an empty transcript", () => {
    expect(effectiveModelSwitchRequest([])).toBeNull();
  });

  it("a single trailing user message carrying a request", () => {
    const messages = [
      { id: "a1", role: "assistant" as const, parts: [{ type: "text" as const, text: "hi" }] },
      userMessage("u1", { provider: "mock-tool-call", model: "mock-model-2" }),
    ];
    expect(effectiveModelSwitchRequest(messages)).toEqual({
      provider: "mock-tool-call",
      model: "mock-model-2",
    });
  });

  it("the LAST trailing user message wins over an earlier one — a flushed queued batch", () => {
    const messages = [
      userMessage("u1", { provider: "mock-tool-call", model: "mock-model-2" }),
      userMessage("u2"),
      userMessage("u3", { provider: "mock-tool-call", model: "mock-model-3" }),
    ];
    expect(effectiveModelSwitchRequest(messages)).toEqual({
      provider: "mock-tool-call",
      model: "mock-model-3",
    });
  });

  it("falls back to an EARLIER trailing user message when the last one carries none", () => {
    const messages = [
      userMessage("u1", { provider: "mock-tool-call", model: "mock-model-2" }),
      userMessage("u2"),
    ];
    expect(effectiveModelSwitchRequest(messages)).toEqual({
      provider: "mock-tool-call",
      model: "mock-model-2",
    });
  });

  it("stops at the first non-user message — an earlier turn's request never leaks forward", () => {
    const messages = [
      userMessage("u0", { provider: "mock-tool-call", model: "mock-model-STALE" }),
      { id: "a1", role: "assistant" as const, parts: [{ type: "text" as const, text: "reply" }] },
      userMessage("u1"),
    ];
    expect(effectiveModelSwitchRequest(messages)).toBeNull();
  });

  it("null when the trailing run carries no request at all", () => {
    expect(effectiveModelSwitchRequest([userMessage("u1"), userMessage("u2")])).toBeNull();
  });
});
