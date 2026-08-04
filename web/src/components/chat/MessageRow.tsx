import { isToolUIPart, type FileUIPart, type ToolUIPart, type UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import type { FeedbackDiagnostics, FeedbackDraftView } from "@/feedback-api";
import { collectFeedbackDiagnostics } from "@/lib/feedback-diagnostics";
import { getToolApproval, getToolPartState } from "@cloudflare/ai-chat/react";
import {
  Message,
  MessageAttachments,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { MessageAttachmentView } from "./MessageAttachmentView";
import { collectMessageFileParts } from "@/lib/message-file-parts";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { buildToolTimeline } from "@/lib/group-tool-parts";
import type { ToolNameServer } from "@/lib/resolve-tool-name";
import { isSteeredMessage } from "@/lib/steering-messages";
import { ArrowBendDownRight } from "@/icons";
import { ApprovalGate } from "./ApprovalGate";
import { ToolGroup } from "./ToolGroup";
import { FeedbackDraftCard } from "@/components/feedback/FeedbackDraftCard";

type AddToolApprovalResponse = (opts: { id: string; approved: boolean }) => void;
type Part = UIMessage["parts"][number];

export function MessageRow({
  message,
  addToolApprovalResponse,
  busy,
  readOnly = false,
  servers,
  showReasoning = true,
  feedbackScreenshots = [],
  onFeedbackDraftSubmit,
  onFeedbackDraftEdit,
  submittedFeedbackDraftIds = new Set(),
}: {
  message: UIMessage;
  addToolApprovalResponse: AddToolApprovalResponse;
  busy: boolean;
  readOnly?: boolean;
  showReasoning?: boolean;
  feedbackScreenshots?: FileUIPart[];
  /** Workspace MCP servers, for mapping namespaced tool keys to friendly names. */
  servers: ToolNameServer[];
  onFeedbackDraftSubmit?: (
    draft: FeedbackDraftView,
    diagnostics: FeedbackDiagnostics,
  ) => Promise<void>;
  onFeedbackDraftEdit?: () => void;
  submittedFeedbackDraftIds?: Set<string>;
}) {
  // Coalesce consecutive tool calls into groups; text/reasoning and any
  // pending-approval tool break the run (approvals must stay visible inline).
  const timeline = buildToolTimeline<Part>(message.parts, {
    isTool: (p) => isToolUIPart(p),
    isWaitingApproval: (p) => isToolUIPart(p) && getToolPartState(p) === "waiting-approval",
    // Parts that carry no visible content must not split a run of consecutive
    // tool calls. Two sources: the SDK's per-step `step-start` boundary, and the
    // empty `text` parts the think runtime emits between tool steps — both
    // render nothing, so treating them as opaque would fragment one dispatch
    // group into several lone cards.
    isTransparent: (p) =>
      p.type === "step-start" ||
      (p.type === "text" && p.text.trim() === "") ||
      (!showReasoning && p.type === "reasoning"),
  });

  // File parts render as a grouped thumbnail/chip grid (skipped in the timeline
  // switch below); images open a lightbox, other types download. Include files
  // the agent pulled in via exec_download_file (synthesized from tool output).
  const fileParts = collectMessageFileParts(message.parts);

  return (
    <Message from={message.role}>
      <MessageContent>
        {isSteeredMessage(message) && (
          <span className="mb-1.5 inline-flex w-fit items-center gap-1 rounded-md border border-steer/40 bg-steer-bg px-1.5 py-0.5 font-bold font-mono text-[10px] text-steer uppercase tracking-wide">
            <ArrowBendDownRight className="size-3" weight="bold" />
            Steered
          </span>
        )}
        {timeline.map((node) => {
          // ── Tool calls → the Dispatch strip card (single or grouped) ──
          if (node.kind === "group") {
            return (
              <ToolGroup
                key={node.key}
                items={node.items.map((it) => ({ key: it.key, part: it.part as ToolUIPart }))}
                servers={servers}
              />
            );
          }
          if (node.kind === "tool") {
            const feedbackDraft = feedbackDraftFromToolPart(node.part as ToolUIPart);
            if (feedbackDraft && onFeedbackDraftSubmit && onFeedbackDraftEdit) {
              return (
                <FeedbackDraftToolCard
                  key={node.key}
                  draft={feedbackDraft}
                  screenshots={feedbackScreenshots}
                  onKeepEditing={onFeedbackDraftEdit}
                  onSubmit={onFeedbackDraftSubmit}
                  submitted={submittedFeedbackDraftIds.has(feedbackDraft.id)}
                />
              );
            }
            return (
              <ToolGroup
                key={node.key}
                items={[{ key: node.key, part: node.part as ToolUIPart }]}
                servers={servers}
              />
            );
          }

          // ── A tool awaiting a human decision → signature approval gate ─
          if (node.kind === "approval") {
            const part = node.part as ToolUIPart;
            const approval = getToolApproval(part);
            const waitingApproval = getToolPartState(part) === "waiting-approval";
            return (
              <ApprovalGate
                key={node.key}
                part={part}
                servers={servers}
                disabled={readOnly || !approval || !waitingApproval}
                onApprove={() =>
                  approval && addToolApprovalResponse({ id: approval.id, approved: true })
                }
                onReject={() =>
                  approval && addToolApprovalResponse({ id: approval.id, approved: false })
                }
              />
            );
          }

          // ── Plain parts: text and reasoning ──────────────────────────
          const part = node.part;
          if (part.type === "text") {
            return <MessageResponse key={node.key}>{part.text}</MessageResponse>;
          }
          if (part.type === "reasoning") {
            return (
              <Reasoning key={node.key} isStreaming={part.state === "streaming"}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          return null;
        })}
        {fileParts.length > 0 && (
          <MessageAttachments
            className={message.role === "assistant" ? "ml-0" : undefined}
          >
            {fileParts.map((part, i) => (
              <MessageAttachmentView key={`attachment-${i}`} data={part} />
            ))}
          </MessageAttachments>
        )}
      </MessageContent>
    </Message>
  );
}

function FeedbackDraftToolCard({
  draft,
  screenshots,
  onKeepEditing,
  onSubmit,
  submitted: initiallySubmitted,
}: {
  draft: FeedbackDraftView;
  screenshots: FileUIPart[];
  onKeepEditing: () => void;
  onSubmit: (draft: FeedbackDraftView, diagnostics: FeedbackDiagnostics) => Promise<void>;
  submitted: boolean;
}) {
  const diagnostics = useMemo(() => collectFeedbackDiagnostics(), []);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(initiallySubmitted);
  useEffect(() => {
    if (initiallySubmitted) setSubmitted(true);
  }, [initiallySubmitted]);

  async function submit() {
    if (submitting || submitted) return;
    setSubmitting(true);
    try {
      await onSubmit(draft, diagnostics);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FeedbackDraftCard
      draft={draft}
      diagnostics={diagnostics}
      screenshots={screenshots}
      submitting={submitting}
      submitted={submitted}
      onKeepEditing={onKeepEditing}
      onSubmit={submit}
    />
  );
}

function feedbackDraftFromToolPart(part: ToolUIPart): FeedbackDraftView | null {
  const maybe = part as unknown as {
    type?: string;
    state?: string;
    output?: unknown;
  };
  if (maybe.type !== "tool-prepare_feedback_report") return null;
  if (maybe.state !== "output-available") return null;
  const output = maybe.output;
  if (!isPlainObject(output)) return null;
  const draft = isPlainObject(output.draft) ? output.draft : output;
  return isFeedbackDraftView(draft) ? draft : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFeedbackDraftView(value: unknown): value is FeedbackDraftView {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.interviewId !== "string") return false;
  if (!isPlainObject(value.fields)) return false;
  const fields = value.fields;
  return (
    (fields.category === "bug" || fields.category === "feature" || fields.category === "general") &&
    typeof fields.title === "string" &&
    typeof fields.narrative === "string" &&
    Array.isArray(fields.reproductionSteps) &&
    fields.reproductionSteps.every((step) => typeof step === "string") &&
    Array.isArray(value.attachmentIds) &&
    value.attachmentIds.every((id) => typeof id === "string") &&
    typeof value.createdAt === "number"
  );
}
