// test/unit/prepare-attachments.test.ts
import type { ModelMessage, UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  extractAttachmentIdsFromModelMessages,
  extractAttachmentIdsFromUiMessages,
  prepareMessagesForModel,
  prepareModelMessagesForModel,
} from "../../src/agent/prepare-attachments";

const resolveAttachment = async (id: string) =>
  id === "img1"
    ? { r2Key: "ws/th/img1.png", mimeType: "image/png", filename: "img1.png" }
    : id === "zip1"
      ? { r2Key: "ws/th/zip1.zip", mimeType: "application/zip", filename: "archive.zip" }
      : null;
const presign = async (key: string) => `https://signed.example/${key}?sig=x`;

function msg(parts: UIMessage["parts"]): UIMessage {
  return { id: "m1", role: "user", parts };
}

describe("prepareMessagesForModel", () => {
  it("keeps image attachments when selected model modalities include image", async () => {
    const out = await prepareMessagesForModel(
      [msg([{ type: "file", url: "/api/attachments/img1", mediaType: "image/png" }])],
      { inputModalities: ["text", "image"], resolveAttachment, presign },
    );

    expect(out[0]?.parts).toEqual([
      {
        type: "file",
        url: "https://signed.example/ws/th/img1.png?sig=x",
        mediaType: "image/png",
      },
    ]);
  });

  it("stubs PDF attachments when selected model modalities do not include file", async () => {
    const resolvePdfAttachment = async () => ({
      r2Key: "ws/th/doc1.pdf",
      mimeType: "application/pdf",
      filename: "report.pdf",
    });
    const out = await prepareMessagesForModel(
      [msg([{ type: "file", url: "/api/attachments/doc1", mediaType: "application/pdf" }])],
      { inputModalities: ["text", "image"], resolveAttachment: resolvePdfAttachment, presign },
    );

    expect(out[0]?.parts).toEqual([
      {
        type: "text",
        text: '📎 The user attached "report.pdf" (application/pdf). It can\'t be read inline by the current model — call getAttachmentUrl with id "doc1" to get a temporary URL you can pass to another tool.',
      },
    ]);
  });

  it("rewrites a supported attachment url to a presigned url", async () => {
    const out = await prepareMessagesForModel(
      [msg([{ type: "file", url: "/api/attachments/img1", mediaType: "image/png" }])],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );
    const part = out[0]!.parts[0] as { type: string; url: string };
    expect(part.url).toBe("https://signed.example/ws/th/img1.png?sig=x");
  });

  it("stubs an unsupported-type attachment alongside surviving text", async () => {
    const out = await prepareMessagesForModel(
      [
        msg([
          { type: "text", text: "see file" },
          { type: "file", url: "/api/attachments/zip1", mediaType: "application/zip" },
        ]),
      ],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );
    expect(out[0]!.parts).toHaveLength(2);
    expect(out[0]!.parts[0]).toMatchObject({ type: "text", text: "see file" });
    expect(out[0]!.parts[1]).toMatchObject({
      type: "text",
      text: '📎 The user attached "archive.zip" (application/zip). It can\'t be read inline by the current model — call getAttachmentUrl with id "zip1" to get a temporary URL you can pass to another tool.',
    });
  });

  it("drops a part whose attachment no longer exists (placeholder inserted when all dropped)", async () => {
    const out = await prepareMessagesForModel(
      [msg([{ type: "file", url: "/api/attachments/missing", mediaType: "image/png" }])],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );
    // Fix 3: all parts dropped → placeholder text inserted so the message is not empty.
    expect(out[0]!.parts).toHaveLength(1);
    expect(out[0]!.parts[0]).toMatchObject({
      type: "text",
      text: "[attachment omitted: not supported by the current model]",
    });
  });

  it("passes non-attachment parts through untouched", async () => {
    const parts = [{ type: "text", text: "hi" } as const];
    const out = await prepareMessagesForModel([msg(parts)], {
      inputModalities: ["text"],
      resolveAttachment,
      presign,
    });
    expect(out[0]!.parts).toEqual(parts);
  });

  // Fix 1: crash-safety — errors in presign or resolveAttachment must not reject the turn
  it("drops the failed part when presign throws, leaves other parts intact", async () => {
    const presignThatThrows = async (key: string) => {
      if (key === "ws/th/img1.png") throw new Error("R2 failure");
      return `https://signed.example/${key}?sig=x`;
    };
    const out = await prepareMessagesForModel(
      [
        msg([
          { type: "text", text: "look here" },
          { type: "file", url: "/api/attachments/img1", mediaType: "image/png" },
        ]),
      ],
      {
        inputModalities: ["text", "image", "file"],
        resolveAttachment,
        presign: presignThatThrows,
      },
    );
    // The text part survives; the failed file part is dropped.
    expect(out[0]!.parts).toHaveLength(1);
    expect(out[0]!.parts[0]).toMatchObject({ type: "text", text: "look here" });
    // The promise itself must not reject.
    await expect(
      prepareMessagesForModel(
        [msg([{ type: "file", url: "/api/attachments/img1", mediaType: "image/png" }])],
        {
          inputModalities: ["text", "image", "file"],
          resolveAttachment,
          presign: presignThatThrows,
        },
      ),
    ).resolves.toBeDefined();
  });

  it("drops the failed part when resolveAttachment throws, leaves other parts intact", async () => {
    const resolveAttachmentThatThrows = async (id: string) => {
      if (id === "img1") throw new Error("DB failure");
      return null;
    };
    const out = await prepareMessagesForModel(
      [
        msg([
          { type: "text", text: "some text" },
          { type: "file", url: "/api/attachments/img1", mediaType: "image/png" },
        ]),
      ],
      {
        inputModalities: ["text", "image", "file"],
        resolveAttachment: resolveAttachmentThatThrows,
        presign,
      },
    );
    expect(out[0]!.parts).toHaveLength(1);
    expect(out[0]!.parts[0]).toMatchObject({ type: "text", text: "some text" });
  });

  it("replaces a lone unsupported attachment with an informative stub", async () => {
    const out = await prepareMessagesForModel(
      [msg([{ type: "file", url: "/api/attachments/zip1", mediaType: "application/zip" }])],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );
    expect(out[0]!.parts).toHaveLength(1);
    expect(out[0]!.parts[0]).toMatchObject({
      type: "text",
      text: '📎 The user attached "archive.zip" (application/zip). It can\'t be read inline by the current model — call getAttachmentUrl with id "zip1" to get a temporary URL you can pass to another tool.',
    });
  });

  it("falls back to the attachment id when filename is null", async () => {
    const resolveNoName = async () => ({
      r2Key: "ws/th/x.bin",
      mimeType: "application/octet-stream",
      filename: null,
    });
    const out = await prepareMessagesForModel(
      [
        msg([
          { type: "file", url: "/api/attachments/bin9", mediaType: "application/octet-stream" },
        ]),
      ],
      { inputModalities: ["text", "image", "file"], resolveAttachment: resolveNoName, presign },
    );
    expect(out[0]!.parts[0]).toMatchObject({
      type: "text",
      text: '📎 The user attached "bin9" (application/octet-stream). It can\'t be read inline by the current model — call getAttachmentUrl with id "bin9" to get a temporary URL you can pass to another tool.',
    });
  });
});

describe("prepareModelMessagesForModel", () => {
  it("rewrites a supported managed model file part to a presigned URL object", async () => {
    const out = await prepareModelMessagesForModel(
      [
        {
          role: "user",
          content: [{ type: "file", data: "/api/attachments/img1", mediaType: "image/png" }],
        },
      ],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );

    const part = (out[0] as { content: Array<{ type: string; data: unknown }> }).content[1]!;
    expect(part.data).toBeInstanceOf(URL);
    expect(String(part.data)).toBe("https://signed.example/ws/th/img1.png?sig=x");
  });

  it("rewrites a supported managed model image part to a presigned URL object", async () => {
    const out = await prepareModelMessagesForModel(
      [
        {
          role: "user",
          content: [{ type: "image", image: "/api/attachments/img1", mediaType: "image/png" }],
        },
      ],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );

    const part = (out[0] as { content: Array<{ type: string; image: unknown }> }).content[1]!;
    expect(part.image).toBeInstanceOf(URL);
    expect(String(part.image)).toBe("https://signed.example/ws/th/img1.png?sig=x");
  });

  it("keeps the managed attachment id visible next to supported model image parts", async () => {
    const out = await prepareModelMessagesForModel(
      [
        {
          role: "user",
          content: [{ type: "image", image: "/api/attachments/img1", mediaType: "image/png" }],
        },
      ],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );

    expect((out[0] as ModelMessage & { content: unknown[] }).content).toEqual([
      {
        type: "text",
        text: 'Attachment reference: use id "img1" for "img1.png" (image/png).',
      },
      {
        type: "image",
        image: new URL("https://signed.example/ws/th/img1.png?sig=x"),
        mediaType: "image/png",
      },
    ]);
  });

  it("stubs an unsupported model content part", async () => {
    const out = await prepareModelMessagesForModel(
      [
        {
          role: "user",
          content: [{ type: "file", data: "/api/attachments/zip1", mediaType: "application/zip" }],
        },
      ],
      { inputModalities: ["text", "image", "file"], resolveAttachment, presign },
    );

    expect((out[0] as ModelMessage & { content: unknown[] }).content).toEqual([
      {
        type: "text",
        text: '📎 The user attached "archive.zip" (application/zip). It can\'t be read inline by the current model — call getAttachmentUrl with id "zip1" to get a temporary URL you can pass to another tool.',
      },
    ]);
  });

  it("passes external model file URLs through untouched", async () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "https://cdn.example/photo.png",
            mediaType: "image/png",
          },
        ],
      },
    ];

    const out = await prepareModelMessagesForModel(messages, {
      inputModalities: ["text", "image", "file"],
      resolveAttachment,
      presign,
    });

    expect(out).toEqual(messages);
  });
});

describe("prepareMessagesForModel with an extractor", () => {
  const imageMsg = () =>
    msg([{ type: "file", url: "/api/attachments/img1", mediaType: "image/png" }]);

  it("inlines a generated context block for a text-only model", async () => {
    const out = await prepareMessagesForModel([imageMsg()], {
      inputModalities: ["text"],
      resolveAttachment,
      presign,
      extract: async () => ({
        text: "Error: undefined is not a function",
        source: "workers-ai-tomarkdown",
      }),
    });

    const part = out[0]?.parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("[Generated context for attachment: img1.png]");
    expect(part.text).toContain("Source: Workers AI (toMarkdown)");
    expect(part.text).toContain("Error: undefined is not a function");
    expect(part.text).toContain("[/Generated context]");
    expect(part.text).not.toContain("truncated:");
  });

  it("labels generated context from the current vision model", async () => {
    const out = await prepareMessagesForModel([imageMsg()], {
      inputModalities: ["text"],
      resolveAttachment,
      presign,
      extract: async () => ({
        text: "receipt total $261.14",
        source: "workers-ai-llama-vision",
      }),
    });

    const part = out[0]?.parts[0] as { type: string; text: string };
    expect(part.text).toContain("Source: Workers AI (Llama 4 Scout)");
    expect(part.text).toContain("receipt total $261.14");
  });

  it("never invokes the extractor when the model can read the type natively", async () => {
    let calls = 0;
    const out = await prepareMessagesForModel([imageMsg()], {
      inputModalities: ["text", "image"],
      resolveAttachment,
      presign,
      extract: async () => {
        calls += 1;
        return { text: "x", source: "workers-ai-tomarkdown" };
      },
    });

    expect(calls).toBe(0);
    expect((out[0]?.parts[0] as { type: string }).type).toBe("file");
  });

  it("falls back to the stub with a failure note when extraction errors", async () => {
    const out = await prepareMessagesForModel([imageMsg()], {
      inputModalities: ["text"],
      resolveAttachment,
      presign,
      extract: async () => ({ error: "workers ai 500" }),
    });

    const part = out[0]?.parts[0] as { type: string; text: string };
    expect(part.text).toContain("call getAttachmentUrl");
    expect(part.text).toContain("Automatic extraction of this attachment failed.");
  });

  it("falls back to the plain stub when the type is not extractable", async () => {
    const out = await prepareMessagesForModel(
      [msg([{ type: "file", url: "/api/attachments/zip1", mediaType: "application/zip" }])],
      { inputModalities: ["text"], resolveAttachment, presign, extract: async () => null },
    );

    const part = out[0]?.parts[0] as { type: string; text: string };
    expect(part.text).toContain("call getAttachmentUrl");
    expect(part.text).not.toContain("Automatic extraction");
  });

  it("truncates long extractions and points at getAttachmentUrl", async () => {
    const long = "a".repeat(20_000);
    const out = await prepareMessagesForModel([imageMsg()], {
      inputModalities: ["text"],
      resolveAttachment,
      presign,
      extract: async () => ({ text: long, source: "workers-ai-tomarkdown" }),
    });

    const part = out[0]?.parts[0] as { type: string; text: string };
    expect(part.text).toContain("[truncated: 12,000 of 20,000 characters");
    expect(part.text).toContain('id "img1"');
  });
});

describe("sibling query passed to the extractor", () => {
  const extracted = { text: "ok", source: "workers-ai-moondream" } as const;
  const filePart = { type: "file" as const, url: "/api/attachments/img1", mediaType: "image/png" };

  function spy() {
    const seen: (string | undefined)[] = [];
    return {
      seen,
      extract: async (_id: string, query?: string) => {
        seen.push(query);
        return extracted;
      },
    };
  }

  it("passes the text the user sent alongside the image", async () => {
    const { seen, extract } = spy();

    await prepareMessagesForModel(
      [msg([{ type: "text", text: "why does this crash?" }, filePart])],
      { inputModalities: ["text"], resolveAttachment, presign, extract },
    );

    expect(seen).toEqual(["why does this crash?"]);
  });

  it("joins multiple text parts of the same message", async () => {
    const { seen, extract } = spy();

    await prepareMessagesForModel(
      [
        msg([
          { type: "text", text: "here it is" },
          filePart,
          { type: "text", text: "what's the port?" },
        ]),
      ],
      { inputModalities: ["text"], resolveAttachment, presign, extract },
    );

    expect(seen).toEqual(["here it is\n\nwhat's the port?"]);
  });

  it("gives both images of one message the same query", async () => {
    const seen: (string | undefined)[] = [];
    const resolveTwo = async (id: string) => ({
      r2Key: `ws/th/${id}.png`,
      mimeType: "image/png",
      filename: `${id}.png`,
    });

    await prepareMessagesForModel(
      [
        msg([
          { type: "text", text: "which of these is newer?" },
          { type: "file", url: "/api/attachments/img1", mediaType: "image/png" },
          { type: "file", url: "/api/attachments/img2", mediaType: "image/png" },
        ]),
      ],
      {
        inputModalities: ["text"],
        resolveAttachment: resolveTwo,
        presign,
        extract: async (_id, query) => {
          seen.push(query);
          return extracted;
        },
      },
    );

    expect(seen).toEqual(["which of these is newer?", "which of these is newer?"]);
  });

  it("passes undefined for a bare image or whitespace-only text", async () => {
    const { seen, extract } = spy();

    await prepareMessagesForModel(
      [msg([filePart]), msg([{ type: "text", text: "   \n " }, filePart])],
      { inputModalities: ["text"], resolveAttachment, presign, extract },
    );

    expect(seen).toEqual([undefined, undefined]);
  });

  it("derives the query on the ModelMessage path too", async () => {
    const { seen, extract } = spy();
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "read the error" },
          { type: "image", image: "/api/attachments/img1" },
        ],
      },
    ];

    await prepareModelMessagesForModel(messages, {
      inputModalities: ["text"],
      resolveAttachment,
      presign,
      extract,
    });

    expect(seen).toEqual(["read the error"]);
  });
});

describe("attachment id extraction", () => {
  it("extracts unique ids from UIMessage file parts", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "hi" },
          { type: "file", url: "/api/attachments/a1", mediaType: "image/png" },
          { type: "file", url: "/api/attachments/a2", mediaType: "image/png" },
          { type: "file", url: "/api/attachments/a1", mediaType: "image/png" },
          { type: "file", url: "https://cdn.example/ignore.png", mediaType: "image/png" },
        ],
      },
      {
        id: "u2",
        role: "assistant",
        parts: [{ type: "file", url: "/api/attachments/a3", mediaType: "image/png" }],
      },
    ];

    expect(extractAttachmentIdsFromUiMessages(messages)).toEqual(["a1", "a2", "a3"]);
  });

  it("extracts unique ids from Think ModelMessage file and image parts", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "see attachments" },
          { type: "file", data: "/api/attachments/m1", mediaType: "image/png" },
          { type: "image", image: "/api/attachments/m2", mediaType: "image/png" },
          { type: "file", data: "/api/attachments/m1", mediaType: "image/png" },
          { type: "image", image: "https://cdn.example/ignore.png", mediaType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "file", data: "/api/attachments/m3", mediaType: "image/png" }],
      },
    ];

    expect(extractAttachmentIdsFromModelMessages(messages)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("retired extraction sources", () => {
  it("still labels rows written before the model switch", async () => {
    const out = await prepareMessagesForModel(
      [msg([{ type: "file", url: "/api/attachments/img1", mediaType: "image/png" }])],
      {
        inputModalities: ["text"],
        resolveAttachment,
        presign,
        // Rows extracted before 2026-08-02 still carry this source forever.
        extract: async () => ({ text: "old row", source: "workers-ai-moondream" }),
      },
    );

    const part = out[0]?.parts[0] as { text: string };
    expect(part.text).toContain("Source: Workers AI (Moondream)");
  });
});
