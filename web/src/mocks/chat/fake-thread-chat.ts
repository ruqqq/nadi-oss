/**
 * The mock app's implementation of the thread-chat seam.
 *
 * This is deliberately a PAIR of hooks, mirroring `thread-chat-seam.ts`:
 *
 *   - `useFakeThreadAgent(thread)`  — stands in for `useThreadAgent`, called
 *     from the NON-suspending `ThreadChatConnected`.
 *   - `useFakeThreadChat(agent, initialMessages)` — stands in for
 *     `useRealThreadChat`, called from `ThreadChat`, which suspends on history.
 *
 * Do not collapse them. The split is load-bearing in production (a `useAgent()`
 * inside a suspending component never commits and so never dials, serializing
 * history-fetch and WS-connect); keeping the mock the same shape is what makes
 * the mock exercise the same component structure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type { ThreadAgent, ThreadChatApi, ThreadAgentSocket } from "../../thread-chat-seam";
import type { ThreadSummary } from "../../threads-api";
import { getStore } from "../store";
import { scriptedReply } from "./turns";

/** ~one frame per tick; slow enough to watch, fast enough not to bore QA. */
const TICK_MS = 40;

/**
 * Canned RPC replies, so the REAL `useSubagentRuns` / `useWatcherRuns` /
 * `usePendingSteers` / draft persistence keep working against the fake socket.
 * Values are the shapes those callers destructure, not invented ones.
 */
const RPC_REPLIES: Record<string, unknown> = {
  listQueuedUserMessages: [],
  getDraft: "",
  setDraft: undefined,
  listPendingSteers: [],
  steer: undefined,
  submitQueuedUserMessage: [],
  cancelSteer: {},
  cancelQueuedUserMessage: undefined,
  // Polled on every thread open by the real watcher/steer/subagent hooks. Not
  // in the plan's table, but leaving them unhandled buries the warn channel
  // under noise the mock already knows the answer to.
  listActiveWatchers: [],
  pendingSteerKeys: [],
  getSubagentRunTimings: {},
  cancelSubagentRun: undefined,
  clearFinishedSubagentRuns: undefined,
  // Confirms a pending workbench switch (see `confirm_workbench_switch` in
  // `src/agent/compute-tools.ts`); the mock always wins the commit permit.
  confirm_workbench_switch: { committed: true },
};

function fakeCall(method: string, args: unknown[]): Promise<unknown> {
  if (method === "prepare_feedback_report") {
    const draft = getStore().feedback.drafts[0];
    return Promise.resolve(draft ? { draft } : { error: "feedback_draft_unavailable" });
  }
  if (method in RPC_REPLIES) return Promise.resolve(RPC_REPLIES[method]);
  // Never resolve an unknown method silently: a fake that quietly answers
  // `undefined` for a method the app has since started calling looks like a
  // product bug rather than a gap in the mock.
  console.warn(`[mock] unhandled agent RPC "${method}"`, args);
  return Promise.resolve(undefined);
}

/**
 * A socket that is permanently open and never emits. `useSocketConnected` reads
 * `readyState` on mount, so the thread clears its "Connecting…" gate at once.
 *
 * Cast to `ThreadAgent` because `ThreadChatProps.agent` is the *inferred*
 * `useAgent` return type, which a structural stand-in cannot satisfy —
 * `preview.tsx` uses the same escape hatch. Do not widen the prop instead.
 */
export function useFakeThreadAgent(thread: ThreadSummary): ThreadAgent {
  return useMemo(() => {
    const socket: ThreadAgentSocket & { id: string; close: () => void; send: () => void } = {
      id: thread.threadId,
      readyState: 1, // WebSocket.OPEN
      addEventListener: () => {},
      removeEventListener: () => {},
      call: fakeCall,
      close: () => {},
      send: () => {},
    };
    return socket as unknown as ThreadAgent;
  }, [thread.threadId]);
}

type Part = Record<string, unknown>;

/** Split a text blob into cumulative prefixes so it visibly types out. */
function textFrames(text: string): string[] {
  const chunks = text.match(/\S+\s*/g) ?? [text];
  const frames: string[] = [];
  let acc = "";
  for (let i = 0; i < chunks.length; i += 1) {
    acc += chunks[i];
    // Every ~3 words; the tail always lands so the final frame is complete.
    if (i % 3 === 2 || i === chunks.length - 1) frames.push(acc);
  }
  return frames.length > 0 ? frames : [text];
}

/**
 * Expand a finished message into the sequence of intermediate `parts` arrays
 * the SDK would have streamed: text types out, and each tool part appears as
 * `input-available` before flipping to its terminal state.
 */
function expandToFrames(message: UIMessage): Part[][] {
  const parts = (message as unknown as { parts: Part[] }).parts;
  const frames: Part[][] = [];
  const done: Part[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      for (const text of textFrames(String(part.text ?? ""))) {
        frames.push([...done, { ...part, text }]);
      }
      done.push(part);
      continue;
    }
    if (part.type === "step-start") {
      done.push(part);
      frames.push([...done]);
      continue;
    }
    // Tool part: show the call in flight, then its result.
    const { output: _output, errorText: _errorText, ...pending } = part;
    frames.push([...done, { ...pending, state: "input-available" }]);
    done.push(part);
    frames.push([...done]);
  }

  if (frames.length === 0) frames.push([...done]);
  return frames;
}

export function useFakeThreadChat(
  agent: ThreadAgent,
  initialMessages: UIMessage[],
): ThreadChatApi {
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [status, setStatus] = useState<string>("ready");
  const [isStreaming, setIsStreaming] = useState(false);
  const timerRef = useRef<number | null>(null);
  const turnIndexRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const stop = useCallback(() => {
    clearTimer();
    setIsStreaming(false);
    setStatus("ready");
  }, [clearTimer]);

  const sendMessage = useCallback(
    (message: unknown, _options?: unknown) => {
      const { text = "", files = [] } = (message ?? {}) as {
        text?: string;
        files?: unknown[];
      };
      clearTimer();

      const userMessage = {
        id: `mock-user-${crypto.randomUUID()}`,
        role: "user",
        parts: [...(text ? [{ type: "text", text }] : []), ...files],
      } as unknown as UIMessage;
      setMessages((current) => [...current, userMessage]);
      setStatus("submitted");

      const reply = scriptedReply(
        turnIndexRef.current,
        (agent as unknown as { id?: string }).id,
      );
      turnIndexRef.current += 1;
      const replyId = (reply as unknown as { id: string }).id;
      const frames = expandToFrames(reply);
      let frame = 0;

      // A beat of "submitted" before the first token, so the pre-stream state
      // is actually observable (it is a distinct composer/indicator state).
      timerRef.current = window.setTimeout(() => {
        setStatus("streaming");
        setIsStreaming(true);
        setMessages((current) => [
          ...current,
          { id: replyId, role: "assistant", parts: [] } as unknown as UIMessage,
        ]);
        timerRef.current = window.setInterval(() => {
          const next = frames[frame];
          frame += 1;
          if (!next) {
            clearTimer();
            setIsStreaming(false);
            setStatus("ready");
            return;
          }
          setMessages((current) =>
            current.map((m) =>
              (m as unknown as { id: string }).id === replyId
                ? ({ id: replyId, role: "assistant", parts: next } as unknown as UIMessage)
                : m,
            ),
          );
        }, TICK_MS);
      }, 250) as unknown as number;
    },
    [clearTimer],
  );

  const addToolApprovalResponse = useCallback((response: { id: string; approved: boolean }) => {
    console.warn("[mock] tool approval is not scripted; ignoring", response);
  }, []);

  return {
    agent: agent as unknown as ThreadAgentSocket,
    messages,
    setMessages,
    sendMessage,
    addToolApprovalResponse,
    status,
    isStreaming,
    error: undefined,
    stop,
  };
}
