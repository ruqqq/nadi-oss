import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  compactionNoticeLabel,
  getCompactionSummary,
  isCompactionMessage,
  manualCompactionNoticeForResult,
  parseCompactionSessionEvent,
  runManualThreadCompaction,
  shouldApplyCompactionStatus,
  shouldQueueSubmitForThreadState,
} from "./thread-compaction";

describe("isCompactionMessage", () => {
  it("recognizes SDK compaction overlay messages", () => {
    expect(isCompactionMessage({ id: "compaction_abc123" })).toBe(true);
    expect(isCompactionMessage({ id: "msg_abc123" })).toBe(false);
  });
});

describe("getCompactionSummary", () => {
  const msg = (parts: UIMessage["parts"]): UIMessage => ({
    id: "compaction_1",
    role: "assistant",
    parts,
  });

  it("returns the joined, trimmed text of a compaction message", () => {
    expect(getCompactionSummary(msg([{ type: "text", text: "## Topic\n\nHello" }]))).toBe(
      "## Topic\n\nHello",
    );
  });

  it("joins multiple text parts and ignores non-text parts", () => {
    expect(
      getCompactionSummary(
        msg([
          { type: "step-start" },
          { type: "text", text: "## Topic" },
          { type: "text", text: "## Open Items" },
        ]),
      ),
    ).toBe("## Topic\n\n## Open Items");
  });

  it("returns an empty string when there is nothing to expand", () => {
    expect(getCompactionSummary(msg([{ type: "step-start" }]))).toBe("");
  });
});

describe("shouldQueueSubmitForThreadState", () => {
  it("queues messages while manual compaction is pending", () => {
    expect(
      shouldQueueSubmitForThreadState({
        busy: false,
        manualCompacting: true,
        hasContent: true,
      }),
    ).toBe(true);
  });
});

describe("parseCompactionSessionEvent", () => {
  it("parses SDK session compaction phase events", () => {
    expect(
      parseCompactionSessionEvent(
        JSON.stringify({
          type: "cf_agent_session",
          phase: "compacting",
          tokenEstimate: 120_000,
          tokenThreshold: 100_000,
        }),
      ),
    ).toEqual({ phase: "compacting", tokenEstimate: 120_000, tokenThreshold: 100_000 });
  });

  it("parses documented uppercase SDK session event types", () => {
    expect(
      parseCompactionSessionEvent(
        JSON.stringify({
          type: "CF_AGENT_SESSION",
          phase: "idle",
        }),
      ),
    ).toEqual({ phase: "idle" });
  });

  it("ignores unrelated and malformed websocket messages", () => {
    expect(parseCompactionSessionEvent(JSON.stringify({ type: "not_this", phase: "idle" }))).toBe(
      null,
    );
    expect(parseCompactionSessionEvent("not json")).toBe(null);
  });
});

describe("shouldApplyCompactionStatus", () => {
  it("accepts an idle status when no manual compaction request is in flight", () => {
    expect(
      shouldApplyCompactionStatus({
        currentPhase: "compacting",
        incomingPhase: "idle",
        manualCompactionInFlight: false,
      }),
    ).toBe(true);
  });

  it("ignores an idle status while a manual compaction request is still in flight", () => {
    expect(
      shouldApplyCompactionStatus({
        currentPhase: "compacting",
        incomingPhase: "idle",
        manualCompactionInFlight: true,
      }),
    ).toBe(false);
  });
});

describe("manualCompactionNoticeForResult", () => {
  it("asks the chat log to show a no-op divider when manual compaction changes nothing", () => {
    expect(
      manualCompactionNoticeForResult({
        compacted: false,
        message: "Nothing to compact yet.",
      }),
    ).toBe("not-needed");
    expect(compactionNoticeLabel("not-needed")).toBe("No compaction needed");
  });

  it("does not add a local divider when the SDK will add a compaction overlay", () => {
    expect(
      manualCompactionNoticeForResult({
        compacted: true,
        message: "Thread compacted.",
      }),
    ).toBe("none");
  });
});

describe("runManualThreadCompaction", () => {
  it("shows a loading toast while manual compaction is pending and resolves it", async () => {
    const toast = {
      loading: vi.fn().mockReturnValue("toast-1"),
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    let resolveCompact!: (value: { compacted: boolean; message: string }) => void;
    const compactThread = vi.fn(
      () =>
        new Promise<{ compacted: boolean; message: string }>((resolve) => {
          resolveCompact = resolve;
        }),
    );

    const pending = runManualThreadCompaction({
      threadId: "thread-1",
      compactThread,
      toast,
    });

    expect(toast.loading).toHaveBeenCalledWith("Compacting thread…");
    expect(toast.success).not.toHaveBeenCalled();

    resolveCompact({ compacted: true, message: "Thread compacted." });
    await expect(pending).resolves.toEqual({
      compacted: true,
      message: "Thread compacted.",
    });

    expect(compactThread).toHaveBeenCalledWith("thread-1");
    expect(toast.success).toHaveBeenCalledWith("Thread compacted.", { id: "toast-1" });
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
