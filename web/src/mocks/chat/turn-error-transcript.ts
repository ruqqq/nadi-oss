import { TURN_ERROR_PART_TYPE } from "../../lib/turn-error";

/**
 * A thread whose turn died before the model said anything — the durable half of
 * a failure that used to be invisible.
 *
 * The state this drives cannot be reached by sending a message in the mock app:
 * it is written by the server when a queued send or an automaton run fails with
 * no client attached, which is exactly why it needs seeding. The wording is the
 * real one from the celld beta, where the only configured provider answered 401
 * on every turn and the thread simply sat on typing dots.
 */
export const TURN_ERROR_THREAD_ID = "thr_turn_error";

export function turnErrorTranscript(): unknown[] {
  return [
    {
      id: "msg_turn_error_user",
      role: "user",
      parts: [{ type: "text", text: "Summarise yesterday's incident report." }],
    },
    {
      id: "turnerr_sub_mock_1",
      role: "assistant",
      parts: [
        {
          type: TURN_ERROR_PART_TYPE,
          data: {
            message:
              "AuthError: This account has found to be committing fraud or is in breach of terms of services and has been blocked.",
          },
        },
      ],
    },
  ];
}
