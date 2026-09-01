import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import {
  chatErrorForClient,
  serializeErrorChain,
  ThreadRefusedError,
} from "../../src/error-details";

describe("serializeErrorChain", () => {
  it("preserves nested error causes", () => {
    const error = new Error("Failed query: select ...", {
      cause: new Error("D1_ERROR: database is unavailable"),
    });

    expect(serializeErrorChain(error)).toMatchObject([
      { name: "Error", message: "Failed query: select ..." },
      { name: "Error", message: "D1_ERROR: database is unavailable" },
    ]);
  });

  it("stops at a circular cause", () => {
    const error: Error & { cause?: unknown } = new Error("outer");
    error.cause = error;

    expect(serializeErrorChain(error)).toEqual([
      expect.objectContaining({ name: "Error", message: "outer" }),
      { name: "CircularErrorCause", message: "Cause chain contains a cycle" },
    ]);
  });

  it("bounds the serialized cause depth", () => {
    let error: Error = new Error("root");
    for (let index = 0; index < 12; index += 1) {
      error = new Error(`wrapper ${index}`, { cause: error });
    }

    const details = serializeErrorChain(error);
    expect(details).toHaveLength(11);
    expect(details.at(-1)).toEqual({
      name: "TruncatedErrorCause",
      message: "Cause chain exceeded 10 entries",
    });
  });
});

describe("chatErrorForClient", () => {
  it("replaces unexpected internal errors with a retryable message", () => {
    const result = chatErrorForClient(new Error("Failed query: select thread_index"));

    expect(result.message).toBe(
      "Something went wrong while sending your message. Please try again.",
    );
  });

  it("shows a thread refusal verbatim, because retrying cannot fix it", () => {
    // "Your agent is turned off" collapsed into "…try again" would be advice
    // that cannot work — the fix is a setting, and the message names it.
    const result = chatErrorForClient(
      new ThreadRefusedError("This thread's agent is turned off. Turn it back on in Settings."),
    );

    expect(result.message).toBe("This thread's agent is turned off. Turn it back on in Settings.");
  });

  it("preserves provider API errors because they are actionable", () => {
    const error = new APICallError({
      message: "Your provider rate limit was exceeded",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "rate limited",
    });

    expect(chatErrorForClient(error)).toBe(error);
  });
});
