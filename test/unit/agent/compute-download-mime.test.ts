import { describe, expect, it, vi } from "vitest";

// Capture what the download tool writes as the attachment mime. The mime must
// survive backend.readFile -> execDownloadFile -> the tool, falling back to a
// filename guess and finally application/octet-stream.
const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }));

vi.mock("../../../src/db/attachment-repository", () => ({
  AttachmentRepository: class {
    insert = insertMock;
  },
}));

import { buildComputeToolDefs } from "../../../src/agent/compute-tools";

function makeDownloadTool(download: { bytes: ArrayBuffer; filename?: string; mimeType?: string }) {
  const env = {
    ATTACHMENTS_BUCKET: { put: vi.fn(async () => {}) },
    REGISTRY_DB: {},
  };
  const tools = buildComputeToolDefs(
    async () => ({ execDownloadFile: async () => download }) as never,
    async () => ({ env, threadId: "thr_1", workspaceId: "ws_1" }) as never,
  );
  return (tools.exec_download_file as { execute: (input: unknown) => Promise<unknown> }).execute;
}

describe("exec_download_file attachment mime", () => {
  it("uses the provider-supplied mime when present", async () => {
    insertMock.mockClear();
    const execute = makeDownloadTool({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      filename: "logo.png",
      mimeType: "image/png",
    });

    const result = (await execute({ path: "/workspace/logo.png" })) as {
      mimeType: string;
      url: string;
      attachmentId: string;
    };

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0]?.[0]).toMatchObject({ mimeType: "image/png" });
    expect(result.mimeType).toBe("image/png");
    expect(result.url).toBe(`/api/attachments/${result.attachmentId}`);
  });

  it("guesses image mime from filename when the provider supplies none", async () => {
    insertMock.mockClear();
    const execute = makeDownloadTool({
      bytes: new Uint8Array([9]).buffer,
      filename: "chart.PNG",
    });

    const result = (await execute({
      path: "/workspace/chart.PNG",
      artifactName: "chart.PNG",
    })) as { mimeType: string };

    expect(insertMock.mock.calls[0]?.[0]).toMatchObject({ mimeType: "image/png" });
    expect(result.mimeType).toBe("image/png");
  });

  it("falls back to application/octet-stream when no mime is supplied or guessable", async () => {
    insertMock.mockClear();
    const execute = makeDownloadTool({
      bytes: new Uint8Array([9]).buffer,
      filename: "plain.bin",
    });

    await execute({ path: "/workspace/plain.bin" });

    expect(insertMock.mock.calls[0]?.[0]).toMatchObject({ mimeType: "application/octet-stream" });
  });
});
