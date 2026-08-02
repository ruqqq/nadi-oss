/**
 * A transcript that stops MID-TURN: it ends on a user message, with no
 * assistant reply after it.
 *
 * This is what the server actually serves while a turn is running — the
 * assistant message isn't persisted until the turn settles — so it is the only
 * way to drive the "a reply is inbound, but nothing is streaming yet" state
 * from the mocked app. Opening this thread should show typing dots and hold
 * them; before the pending-reply fix they vanished the moment the socket
 * reported open.
 */

export const MID_TURN_THREAD_ID = "thr_mid_turn";

export function midTurnTranscript(): unknown[] {
  return [
    {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Can you check whether the deploy picked up the new config?" }],
    },
    {
      id: "m2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "It did — the run pinned the container image instead of rebuilding it, so the deploy was about two minutes instead of seven.",
        },
      ],
    },
    {
      id: "m3",
      role: "user",
      parts: [{ type: "text", text: "Good. Now walk me through what changed in the workflow." }],
    },
  ];
}
