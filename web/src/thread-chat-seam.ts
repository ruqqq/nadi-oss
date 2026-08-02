/**
 * The thread-chat seam.
 *
 * Everything `ThreadChat` needs from the live agent connection lives behind
 * these two hooks, so a mock build can supply an alternate implementation
 * without speaking the real wire protocol.
 */

import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import type { UIMessage } from "ai";
import type { ThreadSummary } from "./threads-api";
import { agentConnectionOptionsForThread } from "./thread-runtime-routing";

/**
 * The socket surface `ThreadChat` and the `lib/use-*-runs` hooks actually
 * touch. Structural on purpose — see `use-socket-connected.ts`'s
 * `ObservableSocket`, and note the warning on `useThreadAgent` below: writing
 * `ReturnType<typeof useAgent>` directly picks the wrong overload.
 */
export interface ThreadAgentSocket {
  readyState: number;
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  call: (method: string, args: unknown[]) => Promise<unknown>;
}

/** Everything `ThreadChat` consumes. Derived from real usage, not invented. */
export interface ThreadChatApi {
  agent: ThreadAgentSocket;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  sendMessage: (message: unknown, options?: unknown) => void;
  // Narrower than `unknown`: App.tsx reads `.approved` to track the decision,
  // and ChatLog/MessageRow declare exactly this shape.
  addToolApprovalResponse: (response: { id: string; approved: boolean }) => void;
  status: string;
  isStreaming: boolean;
  error: Error | undefined;
  stop: () => void;
}

/**
 * Opens a WebSocket to the Durable Object route for this thread's persisted
 * runtime. The Worker validates the Better Auth session against D1 and
 * authorizes registered thread access before routing to this DO.
 *
 * Keep this as a named hook wrapping a real call site so `ThreadAgent` can be
 * inferred from it: `useAgent` is overloaded, and `ReturnType<typeof useAgent>`
 * resolves to the *typed* overload, which doesn't match the untyped one this
 * call site gets.
 *
 * This deliberately stays separate from `useRealThreadChat`: the socket must be
 * dialed from a component that does NOT suspend on the history promise, or the
 * history fetch and the WS connect go strictly serial. See the doc on
 * `ThreadChatConnected` in `App.tsx`.
 */
export function useThreadAgent(thread: ThreadSummary) {
  return useAgent({
    ...agentConnectionOptionsForThread(thread),
    // Uncomment for cross-origin local dev (set VITE_AGENT_HOST in web/.env.local):
    // host: import.meta.env.VITE_AGENT_HOST,
  });
}

export type ThreadAgent = ReturnType<typeof useThreadAgent>;

export function useRealThreadChat(
  agent: ThreadAgent,
  initialMessages: UIMessage[],
): ThreadChatApi {
  const chat = useAgentChat({
    agent,
    getInitialMessages: null,
    messages: initialMessages,
    // Throttle message-store notifications during streaming. The WebSocket
    // transport enqueues every tool-input-delta/text chunk one-by-one, and the
    // AI SDK store reallocates the messages array and synchronously notifies
    // useSyncExternalStore subscribers on each set. A dense chunk burst then
    // stacks >50 nested React re-renders and throws "Maximum update depth
    // exceeded" (React #185). Coalescing the notifications to ~one render per
    // frame keeps that nested-update count bounded. This is the upstream-
    // documented mitigation for cloudflare/agents#1361 (the per-chunk enqueue
    // is unfixed even in the latest transport, so an upgrade would not help).
    experimental_throttle: 50,
  });
  return { agent, ...chat } as unknown as ThreadChatApi;
}
