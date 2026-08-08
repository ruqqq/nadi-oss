import { describe, expect, it, vi } from "vitest";
import { createBaseNativeThreadTools } from "../../../src/agent/thread-tools";
import { createFileTransferTools, uploadToSignedUrl } from "../../../src/agent/file-transfer-tools";

const encoder = new TextEncoder();

function attachmentBucket(bytes: Uint8Array | null) {
  return {
    get: vi.fn(async () =>
      bytes === null
        ? null
        : {
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          },
    ),
  };
}

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "att_1",
    workspaceId: "ws_1",
    threadId: "thr_1",
    mimeType: "text/plain",
    filename: "note.txt",
    byteSize: 5,
    width: null,
    height: null,
    r2Key: "ws_1/thr_1/att_1.txt",
    status: "committed",
    createdAt: 1,
    extractedText: null,
    extractedSource: null,
    extractedAt: null,
    extractedError: null,
    extractedAttempts: 0,
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    env: { ATTACHMENTS_BUCKET: attachmentBucket(encoder.encode("hello")) },
    threadId: "thr_1",
    fetchImpl: vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch,
    attachmentRepository: {
      getByIdInThread: vi.fn(async () => attachmentRow()),
    },
    ...overrides,
  };
}

describe("uploadToSignedUrl", () => {
  it("uploads committed attachment bytes to the signed URL", async () => {
    const testDeps = deps();

    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "https://files.example/upload",
      },
      testDeps as never,
    );

    expect(result).toMatchObject({
      ok: true,
      source: {
        kind: "attachment",
        filename: "note.txt",
        contentType: "text/plain",
        byteSize: 5,
      },
      upload: { method: "PUT", destinationHost: "files.example", status: 200 },
    });
    const fetchImpl = testDeps.fetchImpl as ReturnType<typeof vi.fn>;
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("content-type")).toBe("text/plain");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("hello");
  });

  it("uploads URL source bytes after guarded fetch", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("from url", {
          status: 200,
          headers: { "content-type": "text/markdown", "content-length": "8" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 201 }));

    const result = await uploadToSignedUrl(
      {
        source: { kind: "url", url: "https://source.example/file.md" },
        signedUploadUrl: "https://files.example/upload",
      },
      deps({ fetchImpl }) as never,
    );

    expect(result).toMatchObject({
      ok: true,
      source: { kind: "url", filename: "file.md", contentType: "text/markdown", byteSize: 8 },
      upload: { method: "PUT", destinationHost: "files.example", status: 201 },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://source.example/file.md",
      expect.objectContaining({ redirect: "manual" }),
    );
    const uploadInit = fetchImpl.mock.calls[1]![1] as RequestInit;
    expect(new TextDecoder().decode(uploadInit.body as ArrayBuffer)).toBe("from url");
  });

  it("stops reading URL sources once the byte cap is exceeded", async () => {
    const largeChunk = new Uint8Array(10 * 1024 * 1024 + 1);
    const arrayBuffer = vi.fn(async () => {
      throw new Error("arrayBuffer should not be used for capped URL reads");
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(largeChunk);
          controller.close();
        },
      }),
      arrayBuffer,
    }));

    const result = await uploadToSignedUrl(
      {
        source: { kind: "url", url: "https://source.example/large.bin" },
        signedUploadUrl: "https://files.example/upload",
      },
      deps({ fetchImpl }) as never,
    );

    expect(result).toMatchObject({ ok: false, code: "source_too_large" });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects pending attachments as not found", async () => {
    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "https://files.example/upload",
      },
      deps({
        attachmentRepository: {
          getByIdInThread: vi.fn(async () => attachmentRow({ status: "pending" })),
        },
      }) as never,
    );

    expect(result).toMatchObject({ ok: false, code: "attachment_not_found" });
  });

  it("rejects unsafe source URLs before fetch", async () => {
    const testDeps = deps();

    const result = await uploadToSignedUrl(
      {
        source: { kind: "url", url: "http://127.0.0.1/file" },
        signedUploadUrl: "https://files.example/upload",
      },
      testDeps as never,
    );

    expect(result).toMatchObject({ ok: false, code: "unsafe_source_url" });
    expect(testDeps.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsafe destination URLs before reading the source", async () => {
    const testDeps = deps();

    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "http://127.0.0.1/upload",
      },
      testDeps as never,
    );

    expect(result).toMatchObject({ ok: false, code: "unsafe_destination_url" });
    expect(testDeps.attachmentRepository.getByIdInThread).not.toHaveBeenCalled();
  });

  it("does not echo raw signed destination URLs in unsafe destination errors", async () => {
    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "http://127.0.0.1/upload?X-Amz-Signature=secret",
      },
      deps() as never,
    );

    expect(result).toMatchObject({ ok: false, code: "unsafe_destination_url" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("secret");
      expect(result.message).not.toContain("127.0.0.1");
    }
  });

  it("rejects oversized attachments before reading R2", async () => {
    const bucket = attachmentBucket(encoder.encode("hello"));

    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "https://files.example/upload",
      },
      deps({
        env: { ATTACHMENTS_BUCKET: bucket },
        attachmentRepository: {
          getByIdInThread: vi.fn(async () => attachmentRow({ byteSize: 10 * 1024 * 1024 + 1 })),
        },
      }) as never,
    );

    expect(result).toMatchObject({ ok: false, code: "source_too_large" });
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("rejects disallowed custom headers", async () => {
    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "https://files.example/upload",
        headers: { Authorization: "Bearer secret" },
      },
      deps() as never,
    );

    expect(result).toMatchObject({ ok: false, code: "header_not_allowed" });
  });

  it("rejects conflicting content type inputs", async () => {
    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "https://files.example/upload",
        contentType: "text/plain",
        headers: { "content-type": "application/pdf" },
      },
      deps() as never,
    );

    expect(result).toMatchObject({ ok: false, code: "content_type_conflict" });
  });

  it("returns signed_upload_failed for non-2xx destinations", async () => {
    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "https://files.example/upload",
      },
      deps({ fetchImpl: vi.fn(async () => new Response("denied", { status: 403 })) }) as never,
    );

    expect(result).toMatchObject({ ok: false, code: "signed_upload_failed", status: 403 });
  });

  it("disables destination redirects so upload bytes are not forwarded automatically", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 307 }));

    const result = await uploadToSignedUrl(
      {
        source: { kind: "attachment", attachmentId: "att_1" },
        signedUploadUrl: "https://files.example/upload",
      },
      deps({ fetchImpl }) as never,
    );

    expect(result).toMatchObject({ ok: false, code: "signed_upload_failed", status: 307 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://files.example/upload",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});

describe("createFileTransferTools", () => {
  it("exposes upload_to_signed_url", () => {
    const tools = createFileTransferTools({ env: {} as never, threadId: "thr_1" });

    expect(Object.keys(tools)).toContain("upload_to_signed_url");
  });

  it("marks upload_to_signed_url as approval-required", () => {
    const tools = createFileTransferTools({ env: {} as never, threadId: "thr_1" }) as Record<
      string,
      { needsApproval?: boolean }
    >;

    expect(tools.upload_to_signed_url!.needsApproval).toBe(true);
  });

  it("is included in base native thread tools", () => {
    const tools = createBaseNativeThreadTools({
      env: { REGISTRY_DB: {} } as never,
      threadId: "thr_1",
    });

    expect(Object.keys(tools)).toContain("upload_to_signed_url");
  });
});
