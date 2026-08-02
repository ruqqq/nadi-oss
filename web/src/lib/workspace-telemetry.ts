export function canUseWorkspaceTelemetry({
  consentWorkspaceId,
  workspaceId,
}: {
  consentWorkspaceId: string | null;
  workspaceId: string;
}): boolean {
  return consentWorkspaceId === workspaceId;
}

export function deriveInitialConsentWorkspaceId({
  defaultWorkspaceId,
  pathThreadId,
  threads,
}: {
  defaultWorkspaceId: string | null;
  pathThreadId: string | null;
  threads: Array<{ threadId: string; workspaceId: string }>;
}): string | null {
  if (!pathThreadId) return defaultWorkspaceId;
  return threads.find((thread) => thread.threadId === pathThreadId)?.workspaceId ?? null;
}
