/**
 * Assistant turn that publishes an HTML artifact so MessageRow can synthesize an
 * artifact chip from the tool output (no persisted preview state).
 */

export const ASSISTANT_ARTIFACTS_THREAD_ID = "thr_assistant_artifacts";
export const MOCK_ARTIFACT_ID = "art_mock_dashboard";
export const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

/** Scenario timestamps are frozen in July; expiry uses wall clock so Preview stays usable. */
export function liveArtifactExpiresAt(nowMs = Date.now()): number {
  return nowMs + ARTIFACT_TTL_MS;
}

export function assistantArtifactTranscript(expiresAt = liveArtifactExpiresAt()): unknown[] {
  return [
    {
      id: "msg_aa_user",
      role: "user",
      parts: [
        {
          type: "text",
          text: "Build a usage dashboard from last week's metrics and let me preview it.",
        },
      ],
    },
    {
      id: "msg_aa_assistant",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Published the dashboard — use Preview to open it in your browser.",
        },
        {
          type: "tool-exec_publish_artifact",
          toolCallId: "call_aa_publish",
          state: "output-available",
          input: {
            path: "/workspace/dist",
            entryPath: "index.html",
            title: "Usage dashboard",
          },
          output: {
            artifactId: MOCK_ARTIFACT_ID,
            title: "Usage dashboard",
            entryPath: "index.html",
            fileCount: 3,
            byteSize: 28_400,
            expiresAt,
            url: `/api/artifacts/${MOCK_ARTIFACT_ID}`,
          },
        },
        {
          type: "text",
          text: "The preview link expires in 24 hours.",
        },
      ],
    },
  ];
}
