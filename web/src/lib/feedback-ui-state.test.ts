// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  feedbackDraftSubmitted,
  markFeedbackDraftSubmitted,
  submittedFeedbackDraftIds,
} from "./feedback-ui-state";

const threadId = "thr_feedback";

afterEach(() => {
  localStorage.clear();
});

describe("feedback UI state", () => {
  it("persists submitted draft ids per feedback thread", () => {
    expect(submittedFeedbackDraftIds(threadId)).toEqual(new Set());

    markFeedbackDraftSubmitted(threadId, "draft_1");

    expect(feedbackDraftSubmitted(threadId, "draft_1")).toBe(true);
    expect(feedbackDraftSubmitted(threadId, "draft_2")).toBe(false);
    expect(submittedFeedbackDraftIds(threadId)).toEqual(new Set(["draft_1"]));
  });
});
