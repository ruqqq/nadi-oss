import type { ModelMessage, UIMessage } from "ai";
import type { InjectionBufferLike, InjectionKind } from "./injection-buffer";

// Pure routing decision, extracted so it is unit-testable without a live agent.
// Correctness rests on the durable buffer + drain points; isTurnActive is only
// an optimization to PREFER steering (leave the entry for the running turn's
// beforeStep) over kicking a fresh turn.
export function routeInjection(opts: {
  buffer: InjectionBufferLike;
  isTurnActive: () => boolean;
  kick: () => void;
  now: number;
  entry: { dedupeKey: string; kind: InjectionKind; message: UIMessage };
}): void {
  const written = opts.buffer.enqueue({ ...opts.entry, now: opts.now });
  if (!written) return; // already pending/handled
  if (opts.isTurnActive()) return; // busy → running turn's beforeStep drains it (STEER)
  opts.kick(); // idle → start a turn to consume the buffer
}

// Append injected messages at the END so the model treats them as the newest
// input (not buried before its own in-flight tool output). Callers only call
// this when injections is non-empty.
export function assembleStepMessages(
  eventMessages: ModelMessage[],
  injections: ModelMessage[],
): ModelMessage[] {
  return [...eventMessages, ...injections];
}
