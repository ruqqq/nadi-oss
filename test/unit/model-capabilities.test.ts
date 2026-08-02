import { describe, expect, it } from "vitest";
import { modelSupportsAttachment } from "../../src/agent/model-capabilities";

describe("modelSupportsAttachment", () => {
  it("allows images on vision-capable models", () => {
    expect(modelSupportsAttachment("anthropic", "claude-opus-4-8", "image/png")).toBe(true);
    expect(modelSupportsAttachment("openai", "gpt-4o", "image/jpeg")).toBe(true);
  });

  it("allows pdf on document-capable models", () => {
    expect(modelSupportsAttachment("anthropic", "claude-opus-4-8", "application/pdf")).toBe(true);
  });

  it("rejects unsupported types and unknown/text-only models", () => {
    expect(modelSupportsAttachment("anthropic", "claude-opus-4-8", "application/zip")).toBe(false);
    expect(modelSupportsAttachment("openai", "o1-mini", "image/png")).toBe(false);
    expect(modelSupportsAttachment("mock", "mock", "image/png")).toBe(false);
  });

  it("does not assume attachments work for OpenAI-compatible providers", () => {
    expect(modelSupportsAttachment("deepseek", "deepseek-v4-pro", "image/png")).toBe(false);
    expect(modelSupportsAttachment("zai", "glm-5.2", "application/pdf")).toBe(false);
    expect(modelSupportsAttachment("qwen", "qwen-plus", "image/png")).toBe(false);
  });
});
