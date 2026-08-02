import { describe, expect, it } from "vitest";
import type { FileUIPart, UIMessage } from "ai";
import {
  createNewThread,
  uploadAndSendFirstMessage,
  type NewThreadSendPort,
} from "./new-thread-send";

function fakePort(overrides: Partial<NewThreadSendPort> = {}) {
  const sent: Array<{ threadId: string; message: UIMessage }> = [];
  const port: NewThreadSendPort = {
    createThread: () => Promise.resolve({ threadId: "thr_new" } as never),
    uploadAttachments: (_threadId, files) => Promise.resolve(files),
    sendMessage: (threadId, message) => {
      sent.push({ threadId, message });
      return Promise.resolve();
    },
    newMessageId: () => "msg_1",
    ...overrides,
  };
  return { port, sent };
}

describe("createNewThread", () => {
  it("returns the created thread", async () => {
    const { port } = fakePort();
    const thread = await createNewThread(port, { provider: "anthropic", model: "m" } as never);
    expect(thread.threadId).toBe("thr_new");
  });
});

describe("uploadAndSendFirstMessage", () => {
  it("sends the message to the thread it was given", async () => {
    const { port, sent } = fakePort();

    await uploadAndSendFirstMessage(port, { threadId: "thr_new", text: "hello", files: [] });

    expect(sent).toEqual([
      {
        threadId: "thr_new",
        message: { id: "msg_1", role: "user", parts: [{ type: "text", text: "hello" }] },
      },
    ]);
  });

  it("uploads attachments to that thread and includes them as file parts", async () => {
    const uploaded: FileUIPart = {
      type: "file",
      url: "https://r2/att_1",
      mediaType: "image/png",
      filename: "a.png",
    };
    const uploadTargets: string[] = [];
    const { port, sent } = fakePort({
      uploadAttachments: (threadId) => {
        uploadTargets.push(threadId);
        return Promise.resolve([uploaded]);
      },
    });

    await uploadAndSendFirstMessage(port, {
      threadId: "thr_new",
      text: "look",
      files: [{ type: "file", url: "data:image/png;base64,AA", mediaType: "image/png" }],
    });

    expect(uploadTargets).toEqual(["thr_new"]);
    expect(sent[0]?.message.parts).toEqual([{ type: "text", text: "look" }, uploaded]);
  });

  // The optimistic bubble settles only when THIS id appears in the transcript,
  // so the id must be chosen by the caller (stored on the pending state) rather
  // than minted here and thrown away.
  it("sends with the caller-supplied message id", async () => {
    const { port, sent } = fakePort();

    await uploadAndSendFirstMessage(port, {
      threadId: "thr_new",
      text: "hello",
      files: [],
      messageId: "msg_pinned",
    });

    expect(sent[0]?.message.id).toBe("msg_pinned");
  });

  it("skips the upload round trip when there are no attachments", async () => {
    let uploadCalls = 0;
    const { port } = fakePort({
      uploadAttachments: (_threadId, files) => {
        uploadCalls += 1;
        return Promise.resolve(files);
      },
    });

    await uploadAndSendFirstMessage(port, { threadId: "thr_new", text: "hi", files: [] });

    expect(uploadCalls).toBe(0);
  });

  // The original bug: the send target must be the thread the message was written
  // for, never "whatever thread is selected when the await resolves". A slow port
  // must not change where it lands.
  it("targets the given thread even when the upload resolves late", async () => {
    const { port, sent } = fakePort({
      uploadAttachments: (_threadId, files) =>
        new Promise((resolve) => setTimeout(() => resolve(files), 5)),
    });

    await uploadAndSendFirstMessage(port, {
      threadId: "thr_new",
      text: "hello",
      files: [{ type: "file", url: "data:image/png;base64,AA", mediaType: "image/png" }],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe("thr_new");
  });

  it("never loses the message: falls back to text-only if the upload fails", async () => {
    const { port, sent } = fakePort({
      uploadAttachments: () => Promise.reject(new Error("R2 down")),
    });

    await uploadAndSendFirstMessage(port, {
      threadId: "thr_new",
      text: "hello",
      files: [{ type: "file", url: "data:image/png;base64,AA", mediaType: "image/png" }],
    });

    expect(sent[0]?.message.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  // The upload IS the message here: falling back to text-only would send an
  // empty message, which the server rejects (queued_message_empty) and the
  // attachment would be lost with no error surfaced anywhere.
  it("never sends an empty message: throws if the upload fails and there is no text", async () => {
    const { port, sent } = fakePort({
      uploadAttachments: () => Promise.reject(new Error("R2 down")),
    });

    await expect(
      uploadAndSendFirstMessage(port, {
        threadId: "thr_new",
        text: "",
        files: [{ type: "file", url: "data:image/png;base64,AA", mediaType: "image/png" }],
      }),
    ).rejects.toThrow(/couldn't upload/i);

    expect(sent).toHaveLength(0);
  });

  it("surfaces a send failure as MessageDeliveryError so the caller can offer Retry", async () => {
    const { port } = fakePort({
      sendMessage: () => Promise.reject(new Error("the server is unreachable")),
    });

    await expect(
      uploadAndSendFirstMessage(port, { threadId: "thr_new", text: "hello", files: [] }),
    ).rejects.toThrow(/unreachable/);
  });

  // Retry re-runs this exact function against the same threadId, so a transient
  // failure followed by a retry must land the message in the original thread.
  it("retrying after a failure delivers to the same thread", async () => {
    let attempt = 0;
    const { port, sent } = fakePort({
      sendMessage: (threadId, message) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("network blip"));
        sent.push({ threadId, message });
        return Promise.resolve();
      },
    });

    const input = { threadId: "thr_new", text: "hello", files: [] };
    await expect(uploadAndSendFirstMessage(port, input)).rejects.toThrow(/network blip/);
    await uploadAndSendFirstMessage(port, input);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe("thr_new");
  });
});
