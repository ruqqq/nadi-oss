const SUBMITTED_DRAFTS_PREFIX = "nadi:feedback-submitted-drafts:";

export function submittedFeedbackDraftIds(threadId: string): Set<string> {
  return new Set(readStringArray(`${SUBMITTED_DRAFTS_PREFIX}${threadId}`));
}

export function feedbackDraftSubmitted(threadId: string, draftId: string): boolean {
  return submittedFeedbackDraftIds(threadId).has(draftId);
}

export function markFeedbackDraftSubmitted(threadId: string, draftId: string): void {
  const ids = submittedFeedbackDraftIds(threadId);
  ids.add(draftId);
  writeStringArray(`${SUBMITTED_DRAFTS_PREFIX}${threadId}`, [...ids].slice(-50));
}

function readStringArray(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function writeStringArray(key: string, value: string[]): void {
  localStorage.setItem(key, JSON.stringify(value));
}
