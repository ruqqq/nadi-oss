import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAgentByName, registryDb } = vi.hoisted(() => ({
  getAgentByName: vi.fn(),
  registryDb: vi.fn(),
}));

vi.mock("agents", () => ({ getAgentByName }));
vi.mock("../../../src/db/client", () => ({ registryDb }));

import { routeDebug } from "../../../src/http/debug-routes";
import type { Env } from "../../../src/env";

const TOKEN = "debug-secret-token";

const attachment = {
  id: "att_123",
  workspaceId: "ws_1",
  threadId: "thr_1",
  mimeType: "image/png",
  filename: "screen.png",
  byteSize: 3,
  width: 100,
  height: 40,
  r2Key: "ws_1/thr_1/att_123.png",
  status: "committed",
  extractedText: null,
  extractedSource: null,
  extractedAt: null,
  extractedError: null,
  extractedAttempts: 0,
  createdAt: 1,
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    DEBUG_TOKEN: TOKEN,
    THINK_THREAD_AGENT: {},
    ATTACHMENTS_BUCKET: {
      get: vi.fn(async () => ({
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    },
    AI: {
      run: vi.fn(async () => ({
        result: { answer: "visible text", finish_reason: "stop" },
        usage: { output_tokens: 3 },
      })),
    },
    ...overrides,
  } as unknown as Env;
}

function post(body: unknown, token = TOKEN): Request {
  return new Request("https://example.com/api/debug/ai/moondream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-debug-token": token,
    },
    body: JSON.stringify(body),
  });
}

function dbReturning(row: unknown) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => row),
        })),
      })),
    })),
  };
}

describe("routeDebug - Moondream attachment probe", () => {
  beforeEach(() => {
    getAgentByName.mockReset();
    registryDb.mockReset();
  });

  it("loads an image attachment from R2 and calls Moondream with a non-streaming query", async () => {
    const testEnv = env();
    registryDb.mockReturnValue(dbReturning(attachment));

    const res = await routeDebug(
      post({
        attachmentId: "att_123",
        question: "Transcribe every visible character.",
      }),
      testEnv,
    );

    expect(res?.status).toBe(200);
    expect(registryDb).toHaveBeenCalledWith(testEnv);
    expect(testEnv.ATTACHMENTS_BUCKET.get).toHaveBeenCalledWith("ws_1/thr_1/att_123.png");
    expect(testEnv.AI.run).toHaveBeenCalledWith("@cf/moondream/moondream3.1-9B-A2B", {
      image: "data:image/png;base64,AQID",
      max_tokens: 2048,
      question: "Transcribe every visible character.",
      reasoning: false,
      stream: false,
      task: "query",
      temperature: 0,
    });
    await expect(res!.json()).resolves.toMatchObject({
      attachment: {
        id: "att_123",
        mimeType: "image/png",
        filename: "screen.png",
        byteSize: 3,
        r2Key: "ws_1/thr_1/att_123.png",
      },
      answer: "visible text",
      model: "@cf/moondream/moondream3.1-9B-A2B",
      raw: {
        result: { answer: "visible text", finish_reason: "stop" },
        usage: { output_tokens: 3 },
      },
    });
  });

  it("composes the agent's two-section prompt from `query`", async () => {
    const testEnv = env();
    registryDb.mockReturnValue(dbReturning(attachment));

    const res = await routeDebug(post({ attachmentId: "att_123", query: "which port?" }), testEnv);

    expect(res?.status).toBe(200);
    const input = (testEnv.AI.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      question: string;
      max_tokens: number;
    };
    expect(input.question).toContain("## Transcription");
    expect(input.question).toContain("which port?");
    expect(input.max_tokens).toBe(3072);
  });

  it("lets an explicit `question` override `query`", async () => {
    const testEnv = env();
    registryDb.mockReturnValue(dbReturning(attachment));

    await routeDebug(
      post({ attachmentId: "att_123", question: "just OCR it", query: "which port?" }),
      testEnv,
    );

    const input = (testEnv.AI.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      question: string;
    };
    expect(input.question).toBe("just OCR it");
  });

  it("400s when attachmentId is missing", async () => {
    const testEnv = env();

    const res = await routeDebug(post({}), testEnv);

    expect(res?.status).toBe(400);
    await expect(res!.text()).resolves.toBe("attachmentId required");
    expect(registryDb).not.toHaveBeenCalled();
    expect(testEnv.ATTACHMENTS_BUCKET.get).not.toHaveBeenCalled();
    expect(testEnv.AI.run).not.toHaveBeenCalled();
  });

  it("404s when the attachment row does not exist", async () => {
    const testEnv = env();
    registryDb.mockReturnValue(dbReturning(null));

    const res = await routeDebug(post({ attachmentId: "missing" }), testEnv);

    expect(res?.status).toBe(404);
    await expect(res!.text()).resolves.toBe("attachment not found");
    expect(testEnv.ATTACHMENTS_BUCKET.get).not.toHaveBeenCalled();
    expect(testEnv.AI.run).not.toHaveBeenCalled();
  });

  it("415s for non-image attachments before reading R2", async () => {
    const testEnv = env();
    registryDb.mockReturnValue(dbReturning({ ...attachment, mimeType: "application/pdf" }));

    const res = await routeDebug(post({ attachmentId: "att_123" }), testEnv);

    expect(res?.status).toBe(415);
    await expect(res!.text()).resolves.toBe("attachment must be an image");
    expect(testEnv.ATTACHMENTS_BUCKET.get).not.toHaveBeenCalled();
    expect(testEnv.AI.run).not.toHaveBeenCalled();
  });

  it("404s when the R2 object is missing", async () => {
    const testEnv = env({
      ATTACHMENTS_BUCKET: {
        get: vi.fn(async () => null),
      },
    } as unknown as Partial<Env>);
    registryDb.mockReturnValue(dbReturning(attachment));

    const res = await routeDebug(post({ attachmentId: "att_123" }), testEnv);

    expect(res?.status).toBe(404);
    await expect(res!.text()).resolves.toBe("attachment bytes not found");
    expect(testEnv.AI.run).not.toHaveBeenCalled();
  });
});
