/**
 * Assistant turn that downloads a chart from the sandbox so MessageRow can
 * synthesize an attachment chip from the tool output (no persisted FileUIPart).
 */

export const ASSISTANT_DOWNLOAD_THREAD_ID = "thr_assistant_download";

export function assistantDownloadTranscript(): unknown[] {
  return [
    {
      id: "msg_adl_user",
      role: "user",
      parts: [{ type: "text", text: "Plot last week's churn and send me the chart." }],
    },
    {
      id: "msg_adl_assistant",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Generated the chart in the sandbox — attaching it now.",
        },
        {
          type: "tool-exec_download_file",
          toolCallId: "call_adl_download",
          state: "output-available",
          input: { path: "/workspace/churn_by_segment.png", artifactName: "churn_by_segment.png" },
          output: {
            attachmentId: "att_adl_chart",
            filename: "churn_by_segment.png",
            byteSize: 48_210,
            mimeType: "image/png",
            url: "/api/attachments/att_adl_chart",
          },
        },
        {
          type: "text",
          text: "Chart attached — open it for a closer look or download.",
        },
      ],
    },
  ];
}
