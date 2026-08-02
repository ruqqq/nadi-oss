import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { sanitizeOpenAIOAuthMessages } from "../../../src/agent/openai-oauth-message-sanitize";

describe("sanitizeOpenAIOAuthMessages", () => {
  it("drops persisted reasoning parts and OpenAI item metadata for store:false turns", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Short reasoning summary",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Visible answer",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
              anthropic: {
                cacheControl: { type: "ephemeral" },
              },
            },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Next question" }],
      },
    ];

    expect(sanitizeOpenAIOAuthMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Visible answer",
            providerOptions: {
              anthropic: {
                cacheControl: { type: "ephemeral" },
              },
            },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Next question" }],
      },
    ]);
  });

  it("keeps string assistant content unchanged", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: "Plain answer" }];

    expect(sanitizeOpenAIOAuthMessages(messages)).toBe(messages);
  });
});
