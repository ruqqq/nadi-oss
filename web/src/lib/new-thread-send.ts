import type { FileUIPart, UIMessage } from "ai";
import {
  createThread,
  sendThreadMessage,
  type CreateThreadInput,
  type ThreadSummary,
} from "../threads-api";
import { buildUploadAttachments } from "./attachment-upload";

/**
 * Port so the orchestration is testable without a network or a React tree —
 * mirrors the AutomatonRunPort pattern on the Worker side.
 */
export type NewThreadSendPort = {
  createThread(input: CreateThreadInput): Promise<ThreadSummary>;
  uploadAttachments(threadId: string, files: FileUIPart[]): Promise<FileUIPart[]>;
  sendMessage(threadId: string, message: UIMessage): Promise<void>;
  newMessageId(): string;
};

/**
 * Thrown once the thread already exists — i.e. only the attachment upload or
 * the message POST failed. Callers use this to tell "the thread was created
 * but the message wasn't delivered" apart from "creating the thread failed",
 * since those need different copy.
 */
export class MessageDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageDeliveryError";
  }
}

export const liveNewThreadSendPort: NewThreadSendPort = {
  createThread: (input) => createThread(input),
  uploadAttachments: (threadId, files) => buildUploadAttachments(threadId)(files),
  sendMessage: (threadId, message) => sendThreadMessage(threadId, message),
  newMessageId: () => `msg_${crypto.randomUUID()}`,
};

/**
 * Create the thread. One POST — once it resolves the thread genuinely exists on
 * the server, so the UI can navigate into it immediately. Delivering the first
 * message into it is the slow half (see `uploadAndSendFirstMessage`).
 */
export async function createNewThread(
  port: NewThreadSendPort,
  input: CreateThreadInput,
): Promise<ThreadSummary> {
  return port.createThread(input);
}

/**
 * Deliver the first message INTO an existing thread.
 *
 * The threadId is passed in and threaded through every await, so a slow upload
 * or send can never retarget the message at whatever thread the user has since
 * navigated to. Delivery is a plain HTTP POST, so it completes even if the user
 * navigates away mid-flight — nothing here depends on a mounted <ThreadChat>.
 *
 * This is also exactly what Retry re-runs after a failure, so the first attempt
 * and the retry cannot drift apart.
 */
export async function uploadAndSendFirstMessage(
  port: NewThreadSendPort,
  input: { threadId: string; text: string; files: FileUIPart[]; messageId?: string },
): Promise<void> {
  const { threadId } = input;

  // Attachments were captured as durable data URLs at submit time (no threadId
  // existed yet); now the thread exists, upload them to it.
  let fileParts: FileUIPart[] = [];
  if (input.files.length > 0) {
    try {
      fileParts = await port.uploadAttachments(threadId, input.files);
    } catch (error) {
      // Upload failed (network/R2). If there's text, never lose the message —
      // fall back to sending it text-only. But if the attachment WAS the
      // message (no text), a text-only send would post an empty message that
      // the server rejects — so surface the failure instead of losing it silently.
      console.error("initial attachment upload failed", error);
      if (input.text.trim() === "") {
        throw new MessageDeliveryError(
          "Couldn't upload your attachment, so the message wasn't sent.",
        );
      }
    }
  }

  try {
    // The caller pins the id so the optimistic bubble can recognize this exact
    // message in the transcript (settle / resync are keyed on it).
    await port.sendMessage(threadId, {
      id: input.messageId ?? port.newMessageId(),
      role: "user",
      parts: [{ type: "text", text: input.text }, ...fileParts],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MessageDeliveryError(message);
  }
}
