// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeedbackDraftCard } from "./FeedbackDraftCard";
import { FeedbackFallbackForm } from "./FeedbackFallbackForm";
import type { FeedbackDiagnostics, FeedbackDraftView } from "@/feedback-api";
import { createManualFeedbackDraft } from "@/feedback-api";
import type { FileUIPart } from "ai";

vi.mock("@/feedback-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/feedback-api")>();
  return {
    ...actual,
    createManualFeedbackDraft: vi.fn(),
  };
});

const bugDraft: FeedbackDraftView = {
  id: "draft_bug",
  interviewId: "interview_1",
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
  attachmentIds: ["att_1"],
  createdAt: 1_700_000_000_000,
};

const diagnostics: FeedbackDiagnostics = {
  schemaVersion: 1,
  route: "/feedback",
  build: "test-build",
  browser: "Chromium",
  os: "Linux",
  viewport: { width: 1440, height: 900 },
  theme: "light",
  online: true,
};

const screenshot: FileUIPart = {
  type: "file",
  mediaType: "image/png",
  filename: "flicker.png",
  url: "data:image/png;base64,AAAA",
};

afterEach(() => {
  cleanup();
  vi.mocked(createManualFeedbackDraft).mockReset();
});

describe("FeedbackDraftCard", () => {
  it("discloses the drafted report, diagnostics, screenshots, and confirmation actions", async () => {
    const user = userEvent.setup();
    const onKeepEditing = vi.fn();
    const onSubmit = vi.fn();

    render(
      <FeedbackDraftCard
        draft={bugDraft}
        diagnostics={diagnostics}
        screenshots={[screenshot]}
        submitting={false}
        submitted={false}
        onKeepEditing={onKeepEditing}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText("Archive button flickers")).toBeTruthy();
    expect(screen.getByText("Chromium · Linux")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit feedback" }).hasAttribute("disabled")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onKeepEditing).toHaveBeenCalledOnce();
  });

  it("replaces confirmation actions with the sent state after submission", () => {
    render(
      <FeedbackDraftCard
        draft={bugDraft}
        diagnostics={diagnostics}
        screenshots={[screenshot]}
        submitting={false}
        submitted
        onKeepEditing={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Sent to the Nadi team")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit feedback" })).toBeNull();
  });

  it("only shows screenshots selected into the draft", () => {
    render(
      <FeedbackDraftCard
        draft={{ ...bugDraft, attachmentIds: ["att_1"] }}
        diagnostics={diagnostics}
        screenshots={[
          { ...screenshot, filename: "first.png", attachmentId: "att_1" } as FileUIPart & {
            attachmentId: string;
          },
          { ...screenshot, filename: "second.png", attachmentId: "att_2" } as FileUIPart & {
            attachmentId: string;
          },
        ]}
        submitting={false}
        submitted={false}
        onKeepEditing={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "View first.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View second.png" })).toBeNull();
  });
});

describe("FeedbackFallbackForm", () => {
  it("creates a manual draft with the selected screenshot attachment IDs before confirmation", async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn();
    vi.mocked(createManualFeedbackDraft).mockResolvedValue(bugDraft);

    render(
      <FeedbackFallbackForm
        threadId="thr_feedback"
        screenshots={[{ ...screenshot, attachmentId: "att_1" } as FileUIPart & { attachmentId: string }]}
        initialNarrative="The archive button flickers."
        onDraft={onDraft}
      />,
    );

    await user.type(screen.getByLabelText("Title"), "Archive button flickers");
    await user.click(screen.getByRole("button", { name: "Create draft" }));

    expect(createManualFeedbackDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr_feedback",
        attachmentIds: ["att_1"],
      }),
    );
    expect(onDraft).toHaveBeenCalledWith(bugDraft);
  });

  it("includes bug-specific fallback fields and lets screenshots be excluded", async () => {
    const user = userEvent.setup();
    vi.mocked(createManualFeedbackDraft).mockResolvedValue(bugDraft);

    render(
      <FeedbackFallbackForm
        threadId="thr_feedback"
        screenshots={[
          { ...screenshot, filename: "first.png", attachmentId: "att_1" } as FileUIPart & {
            attachmentId: string;
          },
          { ...screenshot, filename: "second.png", attachmentId: "att_2" } as FileUIPart & {
            attachmentId: string;
          },
        ]}
        initialNarrative="The archive button flickers."
        onDraft={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Title"), "Archive button flickers");
    await user.type(screen.getByLabelText("Reproduction steps"), "Open chats\nArchive a row");
    await user.type(screen.getByLabelText("Expected behavior"), "The row stays hidden.");
    await user.type(screen.getByLabelText("Actual behavior"), "The row comes back.");
    await user.type(screen.getByLabelText("Frequency"), "Always");
    await user.type(screen.getByLabelText("Impact"), "List cleanup is noisy.");
    await user.click(screen.getByRole("checkbox", { name: "Include second.png" }));
    await user.click(screen.getByRole("button", { name: "Create draft" }));

    expect(createManualFeedbackDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: ["att_1"],
        fields: expect.objectContaining({
          reproductionSteps: ["Open chats", "Archive a row"],
          expectedBehavior: "The row stays hidden.",
          actualBehavior: "The row comes back.",
          frequency: "Always",
          impact: "List cleanup is noisy.",
        }),
      }),
    );
  });
});
