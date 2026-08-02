// @vitest-environment jsdom
// web/src/lib/attachment-upload.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { compressToDataUrlAttachments, uploadAttachment } from "./attachment-upload";
import { OfflineError } from "./offline-state";

function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// jsdom's Blob and vitest's node-derived Response/undici don't interoperate (a
// jsdom Blob fed into `new Response(blob)` throws "object.stream is not a
// function"), so these mocks return plain fetch-shaped objects instead of real
// Response instances.
beforeEach(() => {
  // blob fetch for the part url
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith("blob:")) {
        return {
          blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
        } as unknown as Response;
      }
      // upload endpoint
      return {
        ok: true,
        json: async () => ({ id: "abc", url: "/api/attachments/abc", mimeType: "application/pdf" }),
      } as unknown as Response;
    }),
  );
});

describe("uploadAttachment", () => {
  it("uploads a non-image as-is and returns a managed FileUIPart", async () => {
    const result = await uploadAttachment("th1", {
      type: "file",
      url: "blob:fake",
      mediaType: "application/pdf",
      filename: "doc.pdf",
    });
    expect(result.url).toBe("/api/attachments/abc");
    expect(result.mediaType).toBe("application/pdf");
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).endsWith("/api/threads/th1/attachments"))).toBe(true);
  });

  it("throws with the server error code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("blob:")
          ? ({
              blob: async () => new Blob([new Uint8Array([1])], { type: "application/zip" }),
            } as unknown as Response)
          : ({
              ok: false,
              status: 415,
              json: async () => ({ error: "unsupported_file_type" }),
            } as unknown as Response),
      ),
    );
    await expect(
      uploadAttachment("th1", { type: "file", url: "blob:fake", mediaType: "application/zip" }),
    ).rejects.toThrow(/unsupported_file_type/);
  });

  it("rejects with OfflineError instead of attempting the upload while offline", async () => {
    setOnline(false);
    await expect(
      uploadAttachment("th1", {
        type: "file",
        url: "blob:fake",
        mediaType: "application/pdf",
        filename: "doc.pdf",
      }),
    ).rejects.toBeInstanceOf(OfflineError);
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).endsWith("/api/threads/th1/attachments"))).toBe(false);
  });

  it("passes the upload through while online", async () => {
    setOnline(true);
    const result = await uploadAttachment("th1", {
      type: "file",
      url: "blob:fake",
      mediaType: "application/pdf",
      filename: "doc.pdf",
    });
    expect(result.url).toBe("/api/attachments/abc");
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).endsWith("/api/threads/th1/attachments"))).toBe(true);
  });
});

describe("compressToDataUrlAttachments", () => {
  it("encodes a non-image part as a durable data URL (no POST), preserving metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            blob: async () =>
              new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" }),
          }) as unknown as Response,
      ),
    );
    const results = await compressToDataUrlAttachments([
      { type: "file", url: "blob:fake", mediaType: "application/pdf", filename: "doc.pdf" },
    ]);
    const result = results[0];
    if (!result) throw new Error("expected one result");
    expect(result.url.startsWith("data:application/pdf;base64,")).toBe(true);
    expect(result.mediaType).toBe("application/pdf");
    expect(result.filename).toBe("doc.pdf");
    // round-trips back to the original bytes
    expect(atob(result.url.split(",")[1] ?? "")).toBe(String.fromCharCode(1, 2, 3, 4));
    // never hits the upload endpoint
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.every((c) => !String(c[0]).includes("/attachments"))).toBe(true);
  });
});
