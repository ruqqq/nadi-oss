// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  FeedbackReportDetailResponse,
  FeedbackReportPage,
  FeedbackReportSummary,
} from "@/feedback-api";
import { getFeedbackReport, listFeedbackReports, markFeedbackReportSeen } from "@/feedback-api";
import { FeedbackInbox } from "./FeedbackInbox";

vi.mock("@/feedback-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/feedback-api")>();
  return {
    ...actual,
    listFeedbackReports: vi.fn(),
    getFeedbackReport: vi.fn(),
    markFeedbackReportSeen: vi.fn(),
  };
});

const summaries: FeedbackReportSummary[] = [
  {
    id: "fbr_1",
    reporterUserId: "usr_1",
    workspaceId: "ws_1",
    threadId: "thr_1",
    interviewId: "int_1",
    category: "bug",
    title: "Archive button flickers",
    submittedAt: 1_700_000_000_000,
    attachmentCount: 1,
    seen: false,
  },
  {
    id: "fbr_2",
    reporterUserId: "usr_2",
    workspaceId: "ws_1",
    threadId: "thr_2",
    interviewId: "int_2",
    category: "feature",
    title: "Let me pin projects",
    submittedAt: 1_700_000_060_000,
    attachmentCount: 0,
    seen: true,
  },
];

const [archiveFlickerSummary, pinProjectsSummary] = summaries as [
  FeedbackReportSummary,
  FeedbackReportSummary,
];

const detail: FeedbackReportDetailResponse = {
  report: {
    ...archiveFlickerSummary,
    fromMessageId: "msg_start",
    toMessageId: "msg_end",
    fields: {
      category: "bug",
      title: "Archive button flickers",
      narrative: "The archive button flickers when I open the row menu.",
      reproductionSteps: ["Open a chat row", "Click the more menu"],
      expectedBehavior: "The archive action stays stable.",
      actualBehavior: "The archive action flickers.",
      frequency: "Every time",
      impact: "It makes archiving feel risky.",
    },
    diagnostics: {
      schemaVersion: 1,
      route: "/threads/thr_1",
      build: "test-build",
      browser: "Chromium",
      os: "Linux",
      viewport: { width: 1440, height: 900 },
      theme: "dark",
      online: true,
    },
    attachmentIds: ["att_1"],
  },
  transcript: [
    { id: "msg_start", role: "user", parts: [{ type: "text", text: "The archive button flickers." }] },
    { id: "msg_end", role: "assistant", parts: [{ type: "text", text: "What were you doing?" }] },
  ],
  attachments: [{ id: "att_1", url: "data:image/png;base64,AAAA" }],
};

function page(reports = summaries, nextCursor: string | null = null): FeedbackReportPage {
  return { reports, nextCursor };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof FeedbackInbox>> = {}) {
  return {
    selectedId: null,
    revision: 0,
    closeLabel: "Back",
    onClose: vi.fn(),
    onBackToList: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes("min-width: 1024px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  vi.mocked(listFeedbackReports).mockResolvedValue(page());
  vi.mocked(getFeedbackReport).mockResolvedValue(detail);
  vi.mocked(markFeedbackReportSeen).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FeedbackInbox", () => {
  it("renders a read-only master-detail inbox and refreshes page one when the live revision changes", async () => {
    const onClose = vi.fn();
    const onBackToList = vi.fn();
    const onSelect = vi.fn();
    const { rerender } = render(
      <FeedbackInbox
        selectedId={null}
        revision={0}
        closeLabel="Back"
        onClose={onClose}
        onBackToList={onBackToList}
        onSelect={onSelect}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Feedback inbox" })).toBeVisible();
    expect(screen.getByText("Archive button flickers")).toBeVisible();
    expect(screen.getByLabelText("Unseen report")).toBeVisible();
    expect(screen.queryByRole("button", { name: /reply/i })).not.toBeInTheDocument();

    rerender(
      <FeedbackInbox
        selectedId="fbr_1"
        revision={1}
        closeLabel="Back"
        onClose={onClose}
        onBackToList={onBackToList}
        onSelect={onSelect}
      />,
    );

    expect(await screen.findByText("The archive button flickers when I open the row menu.")).toBeVisible();
    expect(screen.getByText("The archive button flickers.")).toBeVisible();
    expect(screen.getByRole("button", { name: "View att_1" })).toBeVisible();
    expect(screen.getByText("Chromium · Linux")).toBeVisible();
    expect(screen.getByText("1440×900")).toBeVisible();
    await waitFor(() => expect(markFeedbackReportSeen).toHaveBeenCalledWith("fbr_1"));
    expect(listFeedbackReports).toHaveBeenCalledTimes(2);
  });

  it("refreshes the selected report detail when the live revision changes", async () => {
    const { rerender } = render(<FeedbackInbox {...baseProps({ selectedId: "fbr_1" })} />);

    expect(await screen.findByText("The archive button flickers when I open the row menu.")).toBeVisible();
    expect(getFeedbackReport).toHaveBeenCalledTimes(1);

    rerender(<FeedbackInbox {...baseProps({ selectedId: "fbr_1", revision: 1 })} />);

    await waitFor(() => expect(getFeedbackReport).toHaveBeenCalledTimes(2));
  });

  it("appends cursor pages without duplicating reports", async () => {
    vi.mocked(listFeedbackReports)
      .mockResolvedValueOnce(page([archiveFlickerSummary], "cursor_2"))
      .mockResolvedValueOnce(page([archiveFlickerSummary, pinProjectsSummary], null));

    render(<FeedbackInbox {...baseProps()} />);
    expect(await screen.findByText("Archive button flickers")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more reports" }));

    expect(await screen.findByText("Let me pin projects")).toBeVisible();
    expect(screen.getAllByText("Archive button flickers")).toHaveLength(1);
    expect(listFeedbackReports).toHaveBeenLastCalledWith({ limit: 25, cursor: "cursor_2" });
  });

  it("shows empty and error states", async () => {
    vi.mocked(listFeedbackReports).mockResolvedValueOnce(page([]));
    const { unmount } = render(<FeedbackInbox {...baseProps()} />);
    expect(await screen.findByText("No feedback reports yet.")).toBeVisible();

    unmount();
    vi.mocked(listFeedbackReports).mockRejectedValueOnce(new Error("Admins only"));
    render(<FeedbackInbox {...baseProps()} />);
    expect(await screen.findByText("Admins only")).toBeVisible();
  });

  it("uses the panel-list return callback for mobile detail Back", async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: !query.includes("min-width: 1024px"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    const onBackToList = vi.fn();
    const onSelect = vi.fn();
    render(<FeedbackInbox {...baseProps({ selectedId: "fbr_1", onBackToList, onSelect })} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onBackToList).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
