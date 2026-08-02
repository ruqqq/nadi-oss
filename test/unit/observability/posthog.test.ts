import { describe, it, expect, vi } from "vitest";

const withTracing = vi.fn((model) => ({ ...model, __traced: true }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("@posthog/ai", () => ({ withTracing: (...a: unknown[]) => (withTracing as any)(...a) }));

const capture = vi.fn();
const flush = vi.fn(async () => {});
vi.mock("posthog-node", () => ({
  PostHog: vi.fn(function () {
    return { capture, flush };
  }),
}));

import { APICallError } from "ai";
import {
  getPostHogClient,
  instrumentModel,
  captureRunError,
  resolveCaptureContent,
} from "../../../src/observability/posthog";
import type { Env } from "../../../src/env";

const baseEnv = { POSTHOG_HOST: "https://us.i.posthog.com" } as unknown as Env;
const model = { modelId: "m" } as never;

describe("getPostHogClient", () => {
  it("returns null when POSTHOG_KEY is unset", async () => {
    await expect(getPostHogClient(baseEnv)).resolves.toBeNull();
  });

  it("returns a memoized client when POSTHOG_KEY is set", async () => {
    const env = { ...baseEnv, POSTHOG_KEY: "phc_x" } as Env;
    const a = await getPostHogClient(env);
    const b = await getPostHogClient(env);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});

describe("instrumentModel", () => {
  it("returns the bare model when client is null", () => {
    const out = instrumentModel(model, {
      client: null,
      workspaceId: "ws",
      threadId: "t",
      traceId: "tr",
      captureContent: true,
    });
    expect(out).toBe(model);
    expect(withTracing).not.toHaveBeenCalled();
  });

  it("wraps with workspace identity and maps captureContent to privacy mode", async () => {
    const client = (await getPostHogClient({ ...baseEnv, POSTHOG_KEY: "phc_x" } as Env))!;
    instrumentModel(model, {
      client,
      workspaceId: "ws-1",
      threadId: "t-1",
      traceId: "tr-1",
      captureContent: false,
      runtime: "legacy",
    });
    expect(withTracing).toHaveBeenCalledWith(model, client, {
      posthogDistinctId: "ws-1",
      posthogGroups: { workspace: "ws-1" },
      posthogProperties: { thread_id: "t-1", runtime: "legacy" },
      posthogTraceId: "tr-1",
      posthogPrivacyMode: true,
    });
  });
});

describe("resolveCaptureContent", () => {
  it('returns true when POSTHOG_CAPTURE_CONTENT is exactly "true"', () => {
    const env = { POSTHOG_CAPTURE_CONTENT: "true" } as unknown as Env;
    expect(resolveCaptureContent(env)).toBe(true);
  });

  it('returns false when POSTHOG_CAPTURE_CONTENT is "false"', () => {
    const env = { POSTHOG_CAPTURE_CONTENT: "false" } as unknown as Env;
    expect(resolveCaptureContent(env)).toBe(false);
  });

  it("returns false when POSTHOG_CAPTURE_CONTENT is undefined (field absent)", () => {
    const env = {} as unknown as Env;
    expect(resolveCaptureContent(env)).toBe(false);
  });

  it('returns false for non-canonical value "True"', () => {
    const env = { POSTHOG_CAPTURE_CONTENT: "True" } as unknown as Env;
    expect(resolveCaptureContent(env)).toBe(false);
  });
});

describe("captureRunError", () => {
  it("is a no-op when client is null", () => {
    captureRunError(null, {
      workspaceId: "ws",
      threadId: "t",
      provider: "p",
      model: "m",
      traceId: "tr",
      error: new Error("boom"),
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures a $exception event with context when client is present", async () => {
    const client = (await getPostHogClient({ ...baseEnv, POSTHOG_KEY: "phc_x" } as Env))!;
    captureRunError(client, {
      workspaceId: "ws-1",
      threadId: "t-1",
      provider: "openai",
      model: "gpt",
      traceId: "tr-1",
      runtime: "think",
      error: new Error("boom"),
    });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "ws-1",
        event: "$exception",
        groups: { workspace: "ws-1" },
        properties: expect.objectContaining({
          thread_id: "t-1",
          provider: "openai",
          model: "gpt",
          runtime: "think",
          $ai_trace_id: "tr-1",
        }),
      }),
    );
  });

  it("captures provider-side detail from an APICallError", async () => {
    const client = (await getPostHogClient({ ...baseEnv, POSTHOG_KEY: "phc_x" } as Env))!;
    const error = new APICallError({
      message: "rate limited",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "z".repeat(1000),
    });
    captureRunError(client, {
      workspaceId: "ws-2",
      threadId: "t-2",
      provider: "anthropic",
      model: "opus",
      traceId: "tr-2",
      runtime: "legacy",
      error,
    });
    const props = capture.mock.calls.at(-1)?.[0]?.properties as Record<string, unknown>;
    expect(props.status_code).toBe(429);
    expect(props.request_url).toBe("https://api.example.com/v1/messages");
    // Response body is truncated to 500 chars to bound size and secret leakage.
    expect((props.response_body as string).length).toBe(500);
  });
});
