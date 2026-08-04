import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { attachmentDownloadUrl, collectMessageFileParts } from "./message-file-parts";

type Part = UIMessage["parts"][number];

describe("collectMessageFileParts", () => {
  it("returns explicit file parts", () => {
    const parts: Part[] = [
      {
        type: "file",
        url: "/api/attachments/a1",
        mediaType: "image/png",
        filename: "shot.png",
      },
    ];
    expect(collectMessageFileParts(parts)).toEqual(parts);
  });

  it("synthesizes a file part from a successful exec_download_file tool result", () => {
    const parts: Part[] = [
      {
        type: "tool-exec_download_file",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "/workspace/chart.png" },
        output: {
          attachmentId: "att_1",
          filename: "chart.png",
          byteSize: 12,
          mimeType: "image/png",
          url: "/api/attachments/att_1",
        },
      } as Part,
    ];
    expect(collectMessageFileParts(parts)).toEqual([
      {
        type: "file",
        url: "/api/attachments/att_1",
        mediaType: "image/png",
        filename: "chart.png",
      },
    ]);
  });

  it("builds the stable url from attachmentId when url is omitted", () => {
    const parts: Part[] = [
      {
        type: "tool-exec_download_file",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "/tmp/a.bin" },
        output: { attachmentId: "att_9", filename: "a.bin", byteSize: 1 },
      } as Part,
    ];
    expect(collectMessageFileParts(parts)[0]?.url).toBe("/api/attachments/att_9");
  });

  it("ignores incomplete or errored download tool parts", () => {
    const parts: Part[] = [
      {
        type: "tool-exec_download_file",
        toolCallId: "call_1",
        state: "input-available",
        input: { path: "/tmp/a.png" },
      } as Part,
      {
        type: "tool-exec_download_file",
        toolCallId: "call_2",
        state: "output-available",
        input: { path: "/tmp/b.png" },
        output: { ok: false, error: "compute_file_too_large" },
      } as Part,
    ];
    expect(collectMessageFileParts(parts)).toEqual([]);
  });

  it("dedupes by url when both an explicit file and download tool share it", () => {
    const parts: Part[] = [
      {
        type: "file",
        url: "/api/attachments/att_1",
        mediaType: "image/png",
        filename: "chart.png",
      },
      {
        type: "tool-exec_download_file",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "/workspace/chart.png" },
        output: {
          attachmentId: "att_1",
          filename: "chart.png",
          mimeType: "image/png",
          url: "/api/attachments/att_1",
        },
      } as Part,
    ];
    expect(collectMessageFileParts(parts)).toHaveLength(1);
  });
});

describe("attachmentDownloadUrl", () => {
  it("appends download=1 to a relative path", () => {
    expect(attachmentDownloadUrl("/api/attachments/a1")).toBe("/api/attachments/a1?download=1");
  });

  it("replaces an existing download flag on absolute URLs", () => {
    expect(attachmentDownloadUrl("https://nadi.test/api/attachments/a1?download=0")).toBe(
      "https://nadi.test/api/attachments/a1?download=1",
    );
  });
});
