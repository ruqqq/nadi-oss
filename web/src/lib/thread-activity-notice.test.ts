import { describe, expect, it } from "vitest";
import { threadActivityNotice } from "./thread-activity-notice";
import type { ThreadSummary } from "../threads-api";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "thr_a",
    title: "Nightly digest",
    attentionRequiredAt: null,
    unreadOutcome: null,
    ...overrides,
  } as ThreadSummary;
}

const idle = { attentionRequiredAt: null, unreadOutcome: null } as const;

describe("threadActivityNotice", () => {
  it("announces a completion the user did not watch", () => {
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ unreadOutcome: "completed" }),
        activeThreadId: "thr_elsewhere",
      }),
    ).toEqual({ threadId: "thr_a", title: "Nightly digest", kind: "completed" });
  });

  it("announces a failure", () => {
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ unreadOutcome: "failed" }),
        activeThreadId: null,
      })?.kind,
    ).toBe("failed");
  });

  it("announces an attention gate", () => {
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ attentionRequiredAt: 1_000 }),
        activeThreadId: null,
      })?.kind,
    ).toBe("attention");
  });

  it("ranks attention above an outcome landing in the same update", () => {
    // A turn that ends by asking for approval carries both fields at once. The
    // blocked agent is the thing worth saying.
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ attentionRequiredAt: 1_000, unreadOutcome: "completed" }),
        activeThreadId: null,
      })?.kind,
    ).toBe("attention");
  });

  it("stays silent for the thread on screen", () => {
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ unreadOutcome: "completed" }),
        activeThreadId: "thr_a",
      }),
    ).toBeNull();
  });

  it("stays silent when nothing transitioned", () => {
    // The rename / project-move / live-status case: thread.updated fires often,
    // and the outcome it carries is the same one already announced.
    expect(
      threadActivityNotice({
        previous: { attentionRequiredAt: null, unreadOutcome: "completed" },
        next: thread({ unreadOutcome: "completed", title: "Renamed" }),
        activeThreadId: null,
      }),
    ).toBeNull();
    expect(
      threadActivityNotice({
        previous: { attentionRequiredAt: 1_000, unreadOutcome: null },
        next: thread({ attentionRequiredAt: 1_000 }),
        activeThreadId: null,
      }),
    ).toBeNull();
  });

  it("stays silent for a thread it has never seen before", () => {
    // Boot and reconnect both deliver threads with no prior state. Announcing
    // them would fire a burst of stale outcomes every time the socket drops.
    expect(
      threadActivityNotice({
        previous: undefined,
        next: thread({ unreadOutcome: "failed", attentionRequiredAt: 2_000 }),
        activeThreadId: null,
      }),
    ).toBeNull();
  });

  it("announces again once the user has cleared the previous outcome", () => {
    // Read it, then it fails on the next run: a real second event.
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ unreadOutcome: "failed" }),
        activeThreadId: null,
      })?.kind,
    ).toBe("failed");
  });

  it("treats an outcome changing kind as news", () => {
    expect(
      threadActivityNotice({
        previous: { attentionRequiredAt: null, unreadOutcome: "completed" },
        next: thread({ unreadOutcome: "failed" }),
        activeThreadId: null,
      })?.kind,
    ).toBe("failed");
  });
});

describe("threadActivityNotice previews", () => {
  it("carries the excerpt the broadcast supplied", () => {
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ unreadOutcome: "completed" }),
        activeThreadId: null,
        preview: "Migrated 14 rows and re-ran the failing suite.",
      })?.preview,
    ).toBe("Migrated 14 rows and re-ran the failing suite.");
  });

  it("omits a blank or whitespace-only preview so the generic copy shows", () => {
    // A turn that produced no prose sends nothing worth quoting; the toast must
    // fall back rather than render an empty second line.
    for (const preview of ["", "   ", undefined]) {
      expect(
        threadActivityNotice({
          previous: idle,
          next: thread({ unreadOutcome: "completed" }),
          activeThreadId: null,
          preview,
        }),
      ).not.toHaveProperty("preview");
    }
  });

  it("trims surrounding whitespace", () => {
    expect(
      threadActivityNotice({
        previous: idle,
        next: thread({ attentionRequiredAt: 1 }),
        activeThreadId: null,
        preview: "  Approve gh pr merge 118?  ",
      })?.preview,
    ).toBe("Approve gh pr merge 118?");
  });
});
