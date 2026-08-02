import { describe, expect, it } from "vitest";
import type { FileUIPart } from "ai";
import {
  activeQueuedMessages,
  displayableQueuedMessages,
  isActiveQueuedStatus,
  isCancellableQueuedStatus,
  mergeQueuedMessages,
  shouldUseQueuedSubmit,
  type QueuedMessage,
} from "./queued-messages";

const file = (url: string, filename = "file.txt"): FileUIPart => ({
  type: "file",
  url,
  mediaType: "application/pdf",
  filename,
});

const message = (
  overrides: Partial<QueuedMessage> & Pick<QueuedMessage, "submissionId" | "status">,
): QueuedMessage => ({
  submissionId: overrides.submissionId,
  status: overrides.status,
  createdAt: overrides.createdAt ?? 100,
  textPreview: overrides.textPreview ?? "",
  attachmentCount: overrides.attachmentCount ?? 0,
  clientMessageId: overrides.clientMessageId ?? "client-1",
  attachments: overrides.attachments ?? [],
  requestId: overrides.requestId,
  error: overrides.error,
  startedAt: overrides.startedAt,
  completedAt: overrides.completedAt,
  cancelling: overrides.cancelling,
});

describe("shouldUseQueuedSubmit", () => {
  it("only queues busy think submits that still have content", () => {
    expect(shouldUseQueuedSubmit({ runtime: "think", busy: true, hasContent: true })).toBe(true);
    expect(shouldUseQueuedSubmit({ runtime: "think", busy: true, hasContent: false })).toBe(false);
    expect(shouldUseQueuedSubmit({ runtime: "think", busy: false, hasContent: true })).toBe(false);
    expect(shouldUseQueuedSubmit({ runtime: "legacy", busy: true, hasContent: true })).toBe(false);
  });
});

describe("isCancellableQueuedStatus", () => {
  // "running" only means the drain loop has claimed the submission — it spends
  // almost its whole wait behind the active turn in that state. It stays
  // cancellable; the server refuses the cancel once the message has actually
  // been applied to the conversation (i.e. it became the active turn).
  it("treats pending and running as cancellable", () => {
    expect(isCancellableQueuedStatus("pending")).toBe(true);
    expect(isCancellableQueuedStatus("running")).toBe(true);
    expect(isCancellableQueuedStatus("completed")).toBe(false);
    expect(isCancellableQueuedStatus("aborted")).toBe(false);
    expect(isCancellableQueuedStatus("skipped")).toBe(false);
    expect(isCancellableQueuedStatus("error")).toBe(false);
  });
});

describe("isActiveQueuedStatus", () => {
  it("treats pending and running as active (non-terminal)", () => {
    expect(isActiveQueuedStatus("pending")).toBe(true);
    expect(isActiveQueuedStatus("running")).toBe(true);
    expect(isActiveQueuedStatus("completed")).toBe(false);
    expect(isActiveQueuedStatus("aborted")).toBe(false);
    expect(isActiveQueuedStatus("skipped")).toBe(false);
    expect(isActiveQueuedStatus("error")).toBe(false);
  });
});

describe("mergeQueuedMessages", () => {
  // Batch rebuilds (merge / per-item cancel) churn submissionId while
  // clientMessageId stays stable — cancelling flags must key on the latter.
  it("keeps active server rows and preserves cancelling flags across a submissionId churn", () => {
    const local = [
      message({
        submissionId: "sub-1",
        status: "pending",
        cancelling: true,
        clientMessageId: "c-1",
        attachments: [file("/api/attachments/a-1")],
      }),
      message({
        submissionId: "sub-local-only",
        status: "running",
        cancelling: true,
        clientMessageId: "c-local-only",
      }),
    ];
    const server = [
      message({
        submissionId: "sub-rebuilt",
        status: "running",
        requestId: "req-1",
        startedAt: 200,
        clientMessageId: "c-1",
      }),
      message({
        submissionId: "sub-rebuilt",
        status: "running",
        requestId: "req-1",
        startedAt: 200,
        clientMessageId: "c-2",
      }),
      message({
        submissionId: "sub-2",
        status: "completed",
        completedAt: 300,
        clientMessageId: "c-done",
      }),
    ];

    expect(mergeQueuedMessages(local, server)).toEqual([
      message({
        submissionId: "sub-rebuilt",
        status: "running",
        requestId: "req-1",
        startedAt: 200,
        cancelling: true,
        clientMessageId: "c-1",
      }),
      message({
        submissionId: "sub-rebuilt",
        status: "running",
        requestId: "req-1",
        startedAt: 200,
        clientMessageId: "c-2",
      }),
    ]);
  });
});

describe("activeQueuedMessages", () => {
  it("keeps non-terminal rows and hides terminal rows", () => {
    expect(
      activeQueuedMessages([
        message({ submissionId: "pending", status: "pending" }),
        message({ submissionId: "running", status: "running" }),
        message({ submissionId: "completed", status: "completed" }),
        message({ submissionId: "aborted", status: "aborted" }),
        message({ submissionId: "skipped", status: "skipped" }),
        message({ submissionId: "error", status: "error" }),
      ]).map((row) => row.submissionId),
    ).toEqual(["pending", "running"]);
  });
});

describe("displayableQueuedMessages", () => {
  // The SDK marks a submission "running" the instant the drain loop claims it —
  // typically right at submit time, while its turn still waits behind the
  // active one. So running rows whose message has NOT entered the conversation
  // are still "waiting in the queue" from the user's perspective and must stay
  // visible. Only the arrival of the message in the stream hides the row.
  it("shows pending and running messages that have not yet entered the conversation", () => {
    const rows = [
      message({ submissionId: "pending", status: "pending", clientMessageId: "c-pending" }),
      message({ submissionId: "running", status: "running", clientMessageId: "c-running" }),
      message({ submissionId: "completed", status: "completed", clientMessageId: "c-done" }),
      message({ submissionId: "aborted", status: "aborted", clientMessageId: "c-aborted" }),
    ];
    expect(
      displayableQueuedMessages(rows, new Set<string>()).map((row) => row.submissionId),
    ).toEqual(["pending", "running"]);
  });

  it("hides a row the instant its message lands in the conversation (no flicker)", () => {
    // Once the user message is in the stream the turn has truly started; the
    // row must not double-render regardless of what the poll reports.
    const rows = [
      message({ submissionId: "pending", status: "pending", clientMessageId: "c-1" }),
      message({ submissionId: "running", status: "running", clientMessageId: "c-2" }),
    ];
    expect(displayableQueuedMessages(rows, new Set(["c-1", "c-2"]))).toEqual([]);
  });

  it("hides a row while its message is represented by an optimistic bubble", () => {
    const rows = [
      message({ submissionId: "first", status: "running", clientMessageId: "msg-first" }),
    ];

    expect(
      displayableQueuedMessages(rows, new Set<string>(), new Set(["msg-first"])),
    ).toEqual([]);
  });

  it("keeps a cancelling row visible until it clears", () => {
    const rows = [
      message({
        submissionId: "pending",
        status: "pending",
        cancelling: true,
        clientMessageId: "c-2",
      }),
    ];
    expect(
      displayableQueuedMessages(rows, new Set<string>()).map((row) => row.submissionId),
    ).toEqual(["pending"]);
  });

  it("hides even a cancelling row once its message is in the conversation", () => {
    const rows = [
      message({
        submissionId: "running",
        status: "running",
        cancelling: true,
        clientMessageId: "c-3",
      }),
    ];
    expect(displayableQueuedMessages(rows, new Set(["c-3"]))).toEqual([]);
  });
});
