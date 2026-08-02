/**
 * Scripted assistant turns for the mock app.
 *
 * The shape here is the AI SDK's on-the-wire `UIMessage` structure, mirrored
 * from `web/src/preview.tsx` (the only other place that hand-builds messages):
 * a message is `{ id, role, parts[] }`; a part is `{type:"text", text}`, a bare
 * `{type:"step-start"}` emitted BEFORE each tool part (that boundary is what
 * makes ChatLog group consecutive tool calls into a Dispatch strip), or a tool
 * part `{type:`tool-${name}`, toolCallId, state, input, output|errorText}`.
 *
 * `UIMessage` is a generic discriminated union over a tool registry, so a
 * literal can't satisfy it structurally — `preview.tsx` casts the same way.
 */

import type { UIMessage } from "ai";
import { getStore } from "../store";

type Part = Record<string, unknown>;

let toolSeq = 0;

/**
 * A completed tool call, preceded by its step boundary.
 *
 * `durationMs` mirrors what the server stamps onto the part in
 * `appendMessageToHistory`. Seeded here so the transcript's duration badge is
 * exercisable in the mock app — pass a value above 1000 to make it render, or
 * omit it for the (equally real) untimed case that predates the feature.
 */
function toolCall(name: string, input: unknown, output: unknown, durationMs?: number): Part[] {
  toolSeq += 1;
  return [
    { type: "step-start" },
    {
      type: `tool-${name}`,
      toolCallId: `mock-call-${toolSeq}`,
      state: "output-available",
      input,
      output,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  ];
}

/** A tool call that failed. `errorText` replaces `output` for "output-error". */
function failedToolCall(name: string, input: unknown, errorText: string): Part[] {
  toolSeq += 1;
  return [
    { type: "step-start" },
    {
      type: `tool-${name}`,
      toolCallId: `mock-call-${toolSeq}`,
      state: "output-error",
      input,
      errorText,
    },
  ];
}

function assistant(id: string, parts: Part[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage;
}

/** Prose only — the baseline "did text stream?" script. */
export const plainTextTurn = (): UIMessage =>
  assistant(`mock-turn-plain-${crypto.randomUUID()}`, [
    {
      type: "text",
      text: [
        "Sure — here's what I found.",
        "",
        "The composer, the streaming indicator, and the message list are all the",
        "**real** components; only the transport is scripted. Markdown renders as",
        "usual, including `inline code` and lists:",
        "",
        "1. Text streams part by part.",
        "2. Tool calls render as cards.",
        "3. The composer returns to ready when the turn ends.",
      ].join("\n"),
    },
  ]);

/** Text, then a run of tool calls (grouped strip), then a closing summary. */
export const toolChainTurn = (): UIMessage =>
  assistant(`mock-turn-tools-${crypto.randomUUID()}`, [
    { type: "text", text: "Let me look at the repository before answering." },
    ...toolCall(
      "read_file",
      { path: "web/src/App.tsx", lines: { start: 3505, end: 3560 } },
      { content: "function ThreadChatConnected({ … }) { … }" },
      2_615,
    ),
    ...toolCall(
      "run_command",
      { command: "rg -n 'useThreadAgent' web/src" },
      { stdout: "web/src/App.tsx:3510:  const agent = useThreadAgent(thread);\n", exitCode: 0 },
      // The orphan-pipe case, at the duration it actually took before the fix.
      123_000,
    ),
    ...toolCall(
      "apply_patch",
      { path: "web/src/thread-chat-seam.ts", patch: "+ export type ThreadAgent = …" },
      { ok: true, linesChanged: 4 },
    ),
    {
      type: "text",
      text: "Done — the seam now exports the inferred agent type, so the mock can supply its own pair of hooks.",
    },
  ]);

/** A turn whose tool call fails, so the error card state is exercised. */
export const errorTurn = (): UIMessage =>
  assistant(`mock-turn-error-${crypto.randomUUID()}`, [
    { type: "text", text: "Checking that file now." },
    ...failedToolCall(
      "read_file",
      { path: "web/src/does-not-exist.ts" },
      "ENOENT: no such file or directory, open 'web/src/does-not-exist.ts'",
    ),
    {
      type: "text",
      text: "That path doesn't exist in the working tree — want me to search for it instead?",
    },
  ]);

export const feedbackDraftTurn = (): UIMessage =>
  assistant(`mock-turn-feedback-${crypto.randomUUID()}`, [
    {
      type: "text",
      text: "I have enough detail to draft this feedback report. Please review it before sending.",
    },
    ...toolCall("prepare_feedback_report", { category: "bug" }, { draft: feedbackDraft() }),
  ]);

function feedbackDraft(): unknown {
  return getStore().feedback.drafts[0] ?? null;
}

const SCRIPTS = [toolChainTurn, plainTextTurn, errorTurn];

/**
 * Pick the reply for the nth message of a thread. Rotating (rather than always
 * replying with the same fixture) means a QA pass sees every card state without
 * anyone having to know which prompt triggers which script.
 */
export function scriptedReply(turnIndex: number, threadId?: string): UIMessage {
  if (threadId === "thr_feedback_mock") return feedbackDraftTurn();
  const make = SCRIPTS[turnIndex % SCRIPTS.length] ?? plainTextTurn;
  return make();
}
