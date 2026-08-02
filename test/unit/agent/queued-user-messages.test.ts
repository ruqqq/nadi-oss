import type { ThinkSubmissionInspection } from "@cloudflare/think";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  appendToQueuedBatch,
  canCancelQueuedUserMessageBatch,
  cancelQueuedUserMessageFromBatch,
  isQueuedBatchApplied,
  NADI_QUEUED_USER_MESSAGE_KIND,
  normalizeQueuedUserMessageInput,
  queuedBatchFromMetadata,
  removeFromQueuedBatch,
  serializeQueuedUserMessageSubmissionRows,
  submitQueuedUserMessageBatch,
  type NormalizedQueuedUserMessage,
  type QueuedSubmissionPort,
  type QueuedUserMessageBatchMetadata,
} from "../../../src/agent/queued-user-messages";
import {
  buildSystemReminderMessage,
  buildWatcherCompletionMessage,
  isSystemReminderMessage,
} from "../../../src/agent/system-reminder";

function message(parts: UIMessage["parts"], id = "msg-1"): UIMessage {
  return { id, role: "user", parts };
}

function textMessage(text: string, id: string): UIMessage {
  return message([{ type: "text", text }], id);
}

function normalized(text: string, id: string) {
  return normalizeQueuedUserMessageInput({ message: textMessage(text, id) });
}

function batchMetadata(
  entries: Array<{ id: string; text: string }>,
): QueuedUserMessageBatchMetadata {
  let batch: ReturnType<typeof appendToQueuedBatch> | null = null;
  for (const entry of entries) {
    batch = appendToQueuedBatch(
      batch ? { items: batch.metadata.items, messages: batch.messages } : null,
      normalized(entry.text, entry.id),
    );
  }
  if (!batch) throw new Error("batchMetadata requires at least one entry");
  return batch.metadata;
}

function inspection(
  overrides: Partial<ThinkSubmissionInspection> & Pick<ThinkSubmissionInspection, "submissionId">,
): ThinkSubmissionInspection {
  return {
    status: "pending",
    createdAt: 100,
    ...overrides,
  } as ThinkSubmissionInspection;
}

describe("normalizeQueuedUserMessageInput", () => {
  it("builds an item with previews for a queued user message", () => {
    const result = normalizeQueuedUserMessageInput({
      message: message([
        { type: "text", text: "  hello world  " },
        {
          type: "file",
          url: "/api/attachments/a1",
          mediaType: "image/png",
          filename: "shot.png",
        },
        {
          type: "file",
          url: "/api/attachments/a2",
          mediaType: "application/pdf",
        },
      ]),
      clientMessageId: "client-123",
    });

    expect(result.attachmentIds).toEqual(["a1", "a2"]);
    expect(result.item).toEqual({
      clientMessageId: "client-123",
      textPreview: "hello world",
      attachmentCount: 2,
      attachments: [
        { type: "file", url: "/api/attachments/a1", mediaType: "image/png", filename: "shot.png" },
        { type: "file", url: "/api/attachments/a2", mediaType: "application/pdf" },
      ],
    });
  });

  it("defaults clientMessageId to the message id", () => {
    expect(normalized("hi", "msg-9").item.clientMessageId).toBe("msg-9");
  });

  it("accepts attachment-only messages", () => {
    const result = normalizeQueuedUserMessageInput({
      message: message([{ type: "file", url: "/api/attachments/only", mediaType: "image/jpeg" }]),
    });
    expect(result.item.textPreview).toBe("");
    expect(result.item.attachmentCount).toBe(1);
  });

  it("rejects invalid message input", () => {
    expect(() => normalizeQueuedUserMessageInput(null)).toThrow("queued_message_invalid");
    expect(() =>
      normalizeQueuedUserMessageInput({ message: { id: "x", role: "assistant", parts: [] } }),
    ).toThrow("queued_message_role");
    expect(() => normalizeQueuedUserMessageInput({ message: message([]) })).toThrow(
      "queued_message_empty",
    );
  });
});

describe("appendToQueuedBatch / removeFromQueuedBatch", () => {
  it("builds a 1-item batch from nothing", () => {
    const batch = appendToQueuedBatch(null, normalized("first", "c-1"));
    expect(batch.metadata.nadiKind).toBe(NADI_QUEUED_USER_MESSAGE_KIND);
    expect(batch.metadata.items.map((item) => item.clientMessageId)).toEqual(["c-1"]);
    expect(batch.messages.map((m) => m.id)).toEqual(["c-1"]);
  });

  it("appends keeping items and messages aligned by index", () => {
    const first = appendToQueuedBatch(null, normalized("first", "c-1"));
    const second = appendToQueuedBatch(
      { items: first.metadata.items, messages: first.messages },
      normalized("second", "c-2"),
    );
    expect(second.metadata.items.map((item) => item.clientMessageId)).toEqual(["c-1", "c-2"]);
    expect(second.messages.map((m) => m.id)).toEqual(["c-1", "c-2"]);
    expect(second.metadata.messages).toEqual(second.messages);
  });

  it("removes a middle item keeping alignment", () => {
    const metadata = batchMetadata([
      { id: "c-1", text: "one" },
      { id: "c-2", text: "two" },
      { id: "c-3", text: "three" },
    ]);
    const remaining = removeFromQueuedBatch(
      { items: metadata.items, messages: metadata.messages },
      "c-2",
    );
    expect(remaining?.metadata.items.map((item) => item.clientMessageId)).toEqual(["c-1", "c-3"]);
    expect(remaining?.messages.map((m) => m.id)).toEqual(["c-1", "c-3"]);
  });

  it("returns null when removing the last item", () => {
    const metadata = batchMetadata([{ id: "c-1", text: "one" }]);
    expect(
      removeFromQueuedBatch({ items: metadata.items, messages: metadata.messages }, "c-1"),
    ).toBeNull();
  });
});

describe("queuedBatchFromMetadata", () => {
  it("round-trips v2 batch metadata", () => {
    const metadata = batchMetadata([
      { id: "c-1", text: "one" },
      { id: "c-2", text: "two" },
    ]);
    const parsed = queuedBatchFromMetadata(JSON.parse(JSON.stringify(metadata)));
    expect(parsed?.items.map((item) => item.clientMessageId)).toEqual(["c-1", "c-2"]);
    expect(parsed?.messages?.map((m) => m.id)).toEqual(["c-1", "c-2"]);
  });

  it("reads legacy v1 single-message metadata as a non-rebuildable 1-item batch", () => {
    const parsed = queuedBatchFromMetadata({
      nadiKind: NADI_QUEUED_USER_MESSAGE_KIND,
      textPreview: "legacy",
      attachmentCount: 1,
      clientMessageId: "c-old",
      attachments: [{ type: "file", url: "/api/attachments/a1" }],
    });
    expect(parsed?.items).toEqual([
      {
        clientMessageId: "c-old",
        textPreview: "legacy",
        attachmentCount: 1,
        attachments: [{ type: "file", url: "/api/attachments/a1" }],
      },
    ]);
    expect(parsed?.messages).toBeNull();
  });

  it("treats a v2 batch with missing or misaligned messages as non-rebuildable", () => {
    const metadata = batchMetadata([
      { id: "c-1", text: "one" },
      { id: "c-2", text: "two" },
    ]);
    const withoutMessages = { ...metadata, messages: undefined };
    expect(queuedBatchFromMetadata(withoutMessages)?.messages).toBeNull();
    const misaligned = { ...metadata, messages: metadata.messages.slice(0, 1) };
    expect(queuedBatchFromMetadata(misaligned)?.messages).toBeNull();
  });

  it("returns null for non-Nadi metadata", () => {
    expect(queuedBatchFromMetadata(undefined)).toBeNull();
    expect(queuedBatchFromMetadata({ nadiKind: "something_else" })).toBeNull();
  });
});

describe("isQueuedBatchApplied / canCancelQueuedUserMessageBatch", () => {
  const items = batchMetadata([
    { id: "c-1", text: "one" },
    { id: "c-2", text: "two" },
  ]).items;

  it("is applied when ANY item's message is in the conversation", () => {
    expect(isQueuedBatchApplied(items, new Set())).toBe(false);
    expect(isQueuedBatchApplied(items, new Set(["c-2"]))).toBe(true);
  });

  it("allows cancel for pending and running unapplied batches only", () => {
    expect(canCancelQueuedUserMessageBatch("pending", items, new Set())).toBe(true);
    expect(canCancelQueuedUserMessageBatch("running", items, new Set())).toBe(true);
    expect(canCancelQueuedUserMessageBatch("running", items, new Set(["c-1"]))).toBe(false);
    for (const status of ["completed", "aborted", "skipped", "error"] as const) {
      expect(canCancelQueuedUserMessageBatch(status, items, new Set())).toBe(false);
    }
  });
});

describe("serializeQueuedUserMessageSubmissionRows", () => {
  it("flattens a v2 batch into one row per item sharing the submission fields", () => {
    const metadata = batchMetadata([
      { id: "c-1", text: "one" },
      { id: "c-2", text: "two" },
    ]);
    const rows = serializeQueuedUserMessageSubmissionRows(
      inspection({
        submissionId: "sub-1",
        status: "running",
        requestId: "req-1",
        createdAt: 123,
        startedAt: 456,
        metadata,
      }),
    );
    expect(rows).toEqual([
      {
        submissionId: "sub-1",
        requestId: "req-1",
        status: "running",
        createdAt: 123,
        startedAt: 456,
        textPreview: "one",
        text: "one",
        attachmentCount: 0,
        clientMessageId: "c-1",
        attachments: [],
      },
      {
        submissionId: "sub-1",
        requestId: "req-1",
        status: "running",
        createdAt: 123,
        startedAt: 456,
        textPreview: "two",
        text: "two",
        attachmentCount: 0,
        clientMessageId: "c-2",
        attachments: [],
      },
    ]);
  });

  it("carries the full untruncated text while textPreview stays capped", () => {
    // textPreview is capped at 240 chars for the strip; `text` restores the
    // whole message (e.g. into the composer when a queued item is cancelled).
    const long = "x".repeat(500);
    const metadata = batchMetadata([{ id: "c-long", text: long }]);
    const rows = serializeQueuedUserMessageSubmissionRows(
      inspection({ submissionId: "sub-long", metadata }),
    );
    expect(rows[0]?.textPreview).toHaveLength(240);
    expect(rows[0]?.text).toBe(long);
  });

  it("serializes legacy v1 metadata as a single row without full text", () => {
    const rows = serializeQueuedUserMessageSubmissionRows(
      inspection({
        submissionId: "sub-old",
        metadata: {
          nadiKind: NADI_QUEUED_USER_MESSAGE_KIND,
          textPreview: "legacy",
          attachmentCount: 0,
          clientMessageId: "c-old",
          attachments: [],
        },
      }),
    );
    expect(rows.map((row) => row.clientMessageId)).toEqual(["c-old"]);
    expect(rows[0]?.text).toBeUndefined();
  });

  it("skips system-reminder messages while keeping real user rows", () => {
    const reminderMessage = buildSystemReminderMessage("proactive nudge");
    expect(isSystemReminderMessage(reminderMessage)).toBe(true);
    const reminderNormalized: NormalizedQueuedUserMessage = {
      message: reminderMessage,
      item: {
        clientMessageId: reminderMessage.id,
        textPreview: "",
        attachmentCount: 0,
        attachments: [],
      },
      attachmentIds: [],
    };

    const first = appendToQueuedBatch(null, normalized("hello", "c-1"));
    const merged = appendToQueuedBatch(
      { items: first.metadata.items, messages: first.messages },
      reminderNormalized,
    );

    const rows = serializeQueuedUserMessageSubmissionRows(
      inspection({ submissionId: "sub-mixed", metadata: merged.metadata }),
    );

    expect(rows.map((row) => row.clientMessageId)).toEqual(["c-1"]);
    expect(rows.map((row) => row.text)).toEqual(["hello"]);
  });

  it("skips watcher-completion messages while keeping real user rows", () => {
    const watcherMessage = buildWatcherCompletionMessage("proc exited", {
      title: "build",
      command: "pnpm build",
      processId: "proc_1",
      outcome: "exited",
      exitCode: 0,
      outputTail: "done\n",
    });
    // Delivered via the same proactive queued path, so it must not surface as a
    // queued-strip row even though (unlike a plain reminder) it stays visible in
    // the transcript.
    const watcherNormalized: NormalizedQueuedUserMessage = {
      message: watcherMessage,
      item: {
        clientMessageId: watcherMessage.id,
        textPreview: "",
        attachmentCount: 0,
        attachments: [],
      },
      attachmentIds: [],
    };

    const first = appendToQueuedBatch(null, normalized("hello", "c-1"));
    const merged = appendToQueuedBatch(
      { items: first.metadata.items, messages: first.messages },
      watcherNormalized,
    );

    const rows = serializeQueuedUserMessageSubmissionRows(
      inspection({ submissionId: "sub-watcher", metadata: merged.metadata }),
    );

    expect(rows.map((row) => row.clientMessageId)).toEqual(["c-1"]);
    expect(rows.map((row) => row.text)).toEqual(["hello"]);
  });

  it("returns no rows for non-Nadi or malformed submissions", () => {
    expect(
      serializeQueuedUserMessageSubmissionRows(
        inspection({ submissionId: "sub-2", metadata: { nadiKind: "something_else" } }),
      ),
    ).toEqual([]);
    expect(
      serializeQueuedUserMessageSubmissionRows(
        inspection({
          submissionId: "sub-3",
          status: "weird" as never,
          metadata: batchMetadata([{ id: "c", text: "x" }]),
        }),
      ),
    ).toEqual([]);
  });
});

type PortLog = Array<
  | { op: "cancel"; submissionId: string; reason: string }
  | { op: "submit"; messageIds: string[]; itemIds: string[] }
>;

function fakePort({
  submissions = [],
  applied = new Set<string>(),
}: {
  submissions?: ThinkSubmissionInspection[];
  applied?: Set<string>;
}): { port: QueuedSubmissionPort; log: PortLog } {
  const log: PortLog = [];
  const port: QueuedSubmissionPort = {
    listSubmissions: async () => submissions,
    inspectSubmission: async (submissionId) =>
      submissions.find((s) => s.submissionId === submissionId) ?? null,
    cancelSubmission: async (submissionId, reason) => {
      log.push({ op: "cancel", submissionId, reason });
    },
    submitMessages: async (messages, options) => {
      log.push({
        op: "submit",
        messageIds: messages.map((m) => m.id),
        itemIds: options.metadata.items.map((item) => item.clientMessageId),
      });
      return inspection({ submissionId: "sub-new", metadata: options.metadata });
    },
    appliedMessageIds: () => applied,
  };
  return { port, log };
}

describe("submitQueuedUserMessageBatch", () => {
  it("submits a fresh 1-item batch when nothing is waiting", async () => {
    const { port, log } = fakePort({});
    await submitQueuedUserMessageBatch(port, normalized("first", "c-1"));
    expect(log).toEqual([{ op: "submit", messageIds: ["c-1"], itemIds: ["c-1"] }]);
  });

  it("merges into the waiting batch: cancels it, resubmits combined messages", async () => {
    const waiting = inspection({
      submissionId: "sub-wait",
      status: "running",
      metadata: batchMetadata([{ id: "c-1", text: "one" }]),
    });
    const { port, log } = fakePort({ submissions: [waiting] });
    await submitQueuedUserMessageBatch(port, normalized("two", "c-2"));
    expect(log).toEqual([
      { op: "cancel", submissionId: "sub-wait", reason: "superseded_by_merge" },
      { op: "submit", messageIds: ["c-1", "c-2"], itemIds: ["c-1", "c-2"] },
    ]);
  });

  it("does not merge into an applied batch (it is the active turn)", async () => {
    const active = inspection({
      submissionId: "sub-active",
      status: "running",
      metadata: batchMetadata([{ id: "c-1", text: "one" }]),
    });
    const { port, log } = fakePort({ submissions: [active], applied: new Set(["c-1"]) });
    await submitQueuedUserMessageBatch(port, normalized("two", "c-2"));
    expect(log).toEqual([{ op: "submit", messageIds: ["c-2"], itemIds: ["c-2"] }]);
  });

  it("does not merge into terminal or legacy non-rebuildable submissions", async () => {
    const terminal = inspection({
      submissionId: "sub-done",
      status: "completed",
      metadata: batchMetadata([{ id: "c-0", text: "done" }]),
    });
    const legacy = inspection({
      submissionId: "sub-legacy",
      status: "pending",
      metadata: {
        nadiKind: NADI_QUEUED_USER_MESSAGE_KIND,
        textPreview: "legacy",
        attachmentCount: 0,
        clientMessageId: "c-old",
        attachments: [],
      },
    });
    const { port, log } = fakePort({ submissions: [terminal, legacy] });
    await submitQueuedUserMessageBatch(port, normalized("new", "c-9"));
    expect(log).toEqual([{ op: "submit", messageIds: ["c-9"], itemIds: ["c-9"] }]);
  });

  it("merges into the newest waiting batch when several exist", async () => {
    const older = inspection({
      submissionId: "sub-old",
      status: "pending",
      createdAt: 100,
      metadata: batchMetadata([{ id: "c-1", text: "one" }]),
    });
    const newer = inspection({
      submissionId: "sub-new-wait",
      status: "pending",
      createdAt: 200,
      metadata: batchMetadata([{ id: "c-2", text: "two" }]),
    });
    const { port, log } = fakePort({ submissions: [older, newer] });
    await submitQueuedUserMessageBatch(port, normalized("three", "c-3"));
    expect(log).toEqual([
      { op: "cancel", submissionId: "sub-new-wait", reason: "superseded_by_merge" },
      { op: "submit", messageIds: ["c-2", "c-3"], itemIds: ["c-2", "c-3"] },
    ]);
  });
});

describe("submitQueuedUserMessageBatch (proactive system-reminder)", () => {
  // Exercises the seam ThinkThreadAgent.deliverSystemReminder's proactive
  // branch calls: a synthetic NormalizedQueuedUserMessage built by hand from
  // buildSystemReminderMessage (not via normalizeQueuedUserMessageInput),
  // submitted through the same port real queued user messages use. This is
  // the level documented in task-4-report.md — the SDK's guarantee that a
  // drained submission runs a turn is established by reading its source
  // (see the report's spike section), not re-verified with a live agent here.
  function reminderNormalized(body: string, id: string): NormalizedQueuedUserMessage {
    const message = buildSystemReminderMessage(body);
    return {
      message: { ...message, id },
      item: { clientMessageId: id, textPreview: "", attachmentCount: 0, attachments: [] },
      attachmentIds: [],
    };
  }

  it("enqueues a submission carrying a system-reminder message", async () => {
    const { port, log } = fakePort({});
    await submitQueuedUserMessageBatch(port, reminderNormalized("go check the thing", "sysrem-1"));

    expect(log).toEqual([{ op: "submit", messageIds: ["sysrem-1"], itemIds: ["sysrem-1"] }]);
  });

  it("submits a message array containing an isSystemReminderMessage-true message", async () => {
    let submittedMessages: UIMessage[] = [];
    const port: QueuedSubmissionPort = {
      listSubmissions: async () => [],
      inspectSubmission: async () => null,
      cancelSubmission: async () => {},
      submitMessages: async (messages, options) => {
        submittedMessages = messages;
        return inspection({ submissionId: "sub-new", metadata: options.metadata });
      },
      appliedMessageIds: () => new Set(),
    };

    await submitQueuedUserMessageBatch(port, reminderNormalized("go check the thing", "sysrem-2"));

    expect(submittedMessages).toHaveLength(1);
    expect(submittedMessages.some((message) => isSystemReminderMessage(message))).toBe(true);
  });

  it("merges a proactive reminder into a waiting real-user batch", async () => {
    const waiting = inspection({
      submissionId: "sub-wait",
      status: "pending",
      metadata: batchMetadata([{ id: "c-1", text: "one" }]),
    });
    const { port, log } = fakePort({ submissions: [waiting] });

    await submitQueuedUserMessageBatch(port, reminderNormalized("nudge", "sysrem-3"));

    expect(log).toEqual([
      { op: "cancel", submissionId: "sub-wait", reason: "superseded_by_merge" },
      { op: "submit", messageIds: ["c-1", "sysrem-3"], itemIds: ["c-1", "sysrem-3"] },
    ]);
  });
});

describe("cancelQueuedUserMessageFromBatch", () => {
  const twoItemBatch = () =>
    inspection({
      submissionId: "sub-1",
      status: "running",
      metadata: batchMetadata([
        { id: "c-1", text: "one" },
        { id: "c-2", text: "two" },
      ]),
    });

  it("cancels the whole submission when removing the only item", async () => {
    const single = inspection({
      submissionId: "sub-solo",
      status: "pending",
      metadata: batchMetadata([{ id: "c-1", text: "one" }]),
    });
    const { port, log } = fakePort({ submissions: [single] });
    await cancelQueuedUserMessageFromBatch(port, "sub-solo", "c-1");
    expect(log).toEqual([{ op: "cancel", submissionId: "sub-solo", reason: "cancelled_by_user" }]);
  });

  it("rebuilds the batch without the removed item", async () => {
    const { port, log } = fakePort({ submissions: [twoItemBatch()] });
    await cancelQueuedUserMessageFromBatch(port, "sub-1", "c-1");
    expect(log).toEqual([
      { op: "cancel", submissionId: "sub-1", reason: "cancelled_by_user" },
      { op: "submit", messageIds: ["c-2"], itemIds: ["c-2"] },
    ]);
  });

  it("refuses when the batch is applied (active turn)", async () => {
    const { port, log } = fakePort({
      submissions: [twoItemBatch()],
      applied: new Set(["c-1"]),
    });
    await cancelQueuedUserMessageFromBatch(port, "sub-1", "c-2");
    expect(log).toEqual([]);
  });

  it("does nothing for unknown submissions or items", async () => {
    const { port, log } = fakePort({ submissions: [twoItemBatch()] });
    await cancelQueuedUserMessageFromBatch(port, "sub-missing", "c-1");
    await cancelQueuedUserMessageFromBatch(port, "sub-1", "c-unknown");
    expect(log).toEqual([]);
  });

  it("cancels a legacy v1 submission whole (single item, not rebuildable)", async () => {
    const legacy = inspection({
      submissionId: "sub-legacy",
      status: "pending",
      metadata: {
        nadiKind: NADI_QUEUED_USER_MESSAGE_KIND,
        textPreview: "legacy",
        attachmentCount: 0,
        clientMessageId: "c-old",
        attachments: [],
      },
    });
    const { port, log } = fakePort({ submissions: [legacy] });
    await cancelQueuedUserMessageFromBatch(port, "sub-legacy", "c-old");
    expect(log).toEqual([
      { op: "cancel", submissionId: "sub-legacy", reason: "cancelled_by_user" },
    ]);
  });
});
