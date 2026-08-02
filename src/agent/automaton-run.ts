import type { UIMessage } from "ai";

/**
 * Builds the message an automaton run submits into thread history. It is an
 * ordinary, visible user message — no metadata, no `<system-reminder>`
 * wrapping (see `./system-reminder.ts` for that, deliberately different,
 * shape). An automaton thread should read honestly: the user can see what was
 * asked and follow up in place.
 */
export function buildAutomatonRunMessage(prompt: string): UIMessage {
  return {
    id: `amsg_${crypto.randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: prompt }],
  };
}

// Orchestration is written against this port (implemented by ThinkThreadAgent
// over the Think SDK) so it is unit-testable without a real Durable Object —
// mirrors the QueuedSubmissionPort pattern in queued-user-messages.ts.
export type AutomatonRunPort = {
  assertThreadWritable(): Promise<void>;
  submitMessages(messages: UIMessage[]): Promise<unknown>;
  serializeQueuedRpc<T>(run: () => Promise<T>): Promise<T>;
};

/**
 * Drives an automaton run's turn: refuse if the thread isn't writable, then
 * submit the prompt as a durable, serialized submission. Returns as soon as
 * the submission row is durable; the SDK drain loop runs the turn with no
 * connected client, so a cron tick never awaits inference.
 */
export async function runAutomatonTurn(port: AutomatonRunPort, prompt: string): Promise<void> {
  await port.assertThreadWritable();
  const message = buildAutomatonRunMessage(prompt);
  await port.serializeQueuedRpc(() => port.submitMessages([message]));
}
