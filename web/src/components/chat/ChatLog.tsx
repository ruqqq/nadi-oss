import { useState } from "react";
import type { FileUIPart, UIMessage } from "ai";
import type { FeedbackDiagnostics, FeedbackDraftView } from "@/feedback-api";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  compactionNoticeLabel,
  getCompactionSummary,
  isCompactionMessage,
  type CompactionNotice,
} from "@/lib/thread-compaction";
import { groupChatMessages } from "@/lib/completion-group";
import type { ToolNameServer } from "@/lib/resolve-tool-name";
import { visibleChatMessages } from "@/lib/system-reminder";
import { latestThreadThinking } from "@/lib/thread-thinking";
import { cn } from "@/lib/utils";
import { CaretDown } from "@/icons";
import { MessageRow } from "./MessageRow";
import { CompletionGroup } from "./CompletionGroup";
import type { SubagentRunsState } from "@/lib/use-subagent-runs";
import { TypingDots } from "./TypingDots";
import { assistantHasPainted, withRenderableContent } from "@/lib/message-state";

type AddToolApprovalResponse = (opts: { id: string; approved: boolean }) => void;

/**
 * The "Thread compacted" rule. A bare divider for notices (e.g. "No compaction
 * needed"); when a compaction carries a `summary`, the label becomes a
 * click-to-expand disclosure that reveals the persisted digest inline.
 */
function CompactionDivider({
  label = "Thread compacted",
  summary,
}: {
  label?: string;
  summary?: string;
}) {
  const [open, setOpen] = useState(false);

  if (!summary) {
    return (
      <div
        className="flex items-center gap-3 py-3 text-xs text-muted-foreground"
        role="separator"
        aria-label={label}
      >
        <span className="h-px min-w-6 flex-1 bg-border" />
        <span className="shrink-0 font-mono">{label}</span>
        <span className="h-px min-w-6 flex-1 bg-border" />
      </div>
    );
  }

  return (
    <div className="min-w-0 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="h-px min-w-6 flex-1 bg-border" />
        <span className="flex shrink-0 items-center gap-1.5 font-mono">
          {label}
          <CaretDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        </span>
        <span className="h-px min-w-6 flex-1 bg-border" />
      </button>
      {open && (
        // min-w-0 lets this flex child shrink; overflow-wrap:anywhere (inherited)
        // breaks long unbreakable tokens in the digest — chiefly inline-code URLs
        // like an R2 storage link — so they wrap instead of stretching the column.
        // overflow-x-auto is only a safety net for <pre>/tables, which preserve
        // whitespace and can't wrap.
        <div className="mt-3 min-w-0 max-w-full overflow-x-auto rounded-lg border bg-muted/30 px-4 py-3 text-sm [overflow-wrap:anywhere]">
          <MessageResponse>{summary}</MessageResponse>
        </div>
      )}
    </div>
  );
}

function CompactionProgressRow() {
  return (
    <div
      className="flex items-center gap-3 py-3 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
      aria-label="Compacting thread"
    >
      <span className="h-px min-w-6 flex-1 bg-border" />
      <span className="shrink-0 font-mono">Compacting thread...</span>
      <span className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}

export function ChatLog({
  messages,
  addToolApprovalResponse,
  busy,
  showTyping,
  readOnly = false,
  error,
  servers,
  emptyTitle = "No messages yet",
  emptyDescription = "Send a message to start. Nadi may ask you to approve a tool mid-turn.",
  hasPendingBubble = false,
  compactionPhase = "idle",
  compactionNotice = "none",
  subagentRuns,
  showReasoning = true,
  onFeedbackDraftSubmit,
  onFeedbackDraftEdit,
  submittedFeedbackDraftIds = new Set(),
}: {
  messages: UIMessage[];
  addToolApprovalResponse: AddToolApprovalResponse;
  busy: boolean;
  showTyping: boolean;
  compactionPhase?: "idle" | "compacting";
  compactionNotice?: CompactionNotice;
  readOnly?: boolean;
  /**
   * Whether to render the model's thinking. This gates the LIVE block below —
   * the only place thinking is actually shown, since MessageRow is always
   * passed `showReasoning={false}`.
   *
   * Until effort became its own setting, `showReasoning: false` also stopped the
   * model thinking at the provider, so nothing ever reached this component and
   * the flag appeared to work. It never did.
   */
  showReasoning?: boolean;
  error?: Error;
  /** Workspace MCP servers, for friendly tool names. */
  servers: ToolNameServer[];
  emptyTitle?: string;
  emptyDescription?: string;
  /** Suppress the empty state while a first-message bubble renders below the log:
   *  the thread has no persisted messages yet, but it is not "empty" to the user. */
  hasPendingBubble?: boolean;
  /** Live subagent run state; absent for the read-only archive view (no socket). */
  subagentRuns?: SubagentRunsState;
  onFeedbackDraftSubmit?: (
    draft: FeedbackDraftView,
    diagnostics: FeedbackDiagnostics,
  ) => Promise<void>;
  onFeedbackDraftEdit?: () => void;
  submittedFeedbackDraftIds?: Set<string>;
}) {
  // Contentless assistant rows are dropped here rather than inside
  // visibleChatMessages, which owns a different question (hidden system
  // reminders). See rendersNoContent for why an invisible row still matters.
  const visibleMessages = withRenderableContent(visibleChatMessages(messages));
  const empty = visibleMessages.length === 0 && !busy && !hasPendingBubble;
  const feedbackScreenshots = visibleMessages.flatMap((message) =>
    message.parts.filter((part): part is FileUIPart => part.type === "file"),
  );
  const latestThinking = latestThreadThinking(visibleMessages);
  const compactionNoticeText = compactionNoticeLabel(compactionNotice);
  const liveThinking = showReasoning ? latestThinking : null;
  // Is anything of this turn already on screen for the dots to trail?
  const turnPainted =
    assistantHasPainted(visibleMessages) ||
    !!liveThinking ||
    !!compactionNoticeText ||
    compactionPhase === "compacting";

  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {empty ? (
          <ConversationEmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          groupChatMessages(visibleMessages).map((item) =>
            item.kind === "completions" ? (
              <CompletionGroup
                key={item.run[0]?.id ?? "completions"}
                run={item.run}
                runsById={subagentRuns?.runsById ?? {}}
              />
            ) : isCompactionMessage(item.message) ? (
              <CompactionDivider
                key={item.message.id}
                summary={getCompactionSummary(item.message)}
              />
            ) : (
              <MessageRow
                key={item.message.id}
                message={item.message}
                addToolApprovalResponse={addToolApprovalResponse}
                busy={busy}
                readOnly={readOnly}
                servers={servers}
                showReasoning={false}
                feedbackScreenshots={feedbackScreenshots}
                onFeedbackDraftSubmit={onFeedbackDraftSubmit}
                onFeedbackDraftEdit={onFeedbackDraftEdit}
                submittedFeedbackDraftIds={submittedFeedbackDraftIds}
              />
            ),
          )
        )}

        {compactionNoticeText && <CompactionDivider label={compactionNoticeText} />}

        {compactionPhase === "compacting" && <CompactionProgressRow />}

        {liveThinking && (
          <Reasoning key={liveThinking.key} isStreaming={liveThinking.state === "streaming"}>
            <ReasoningTrigger />
            <ReasoningContent>{liveThinking.text}</ReasoningContent>
          </Reasoning>
        )}

        {showTyping && (
          // ConversationContent gaps children by gap-8 (message rhythm), and
          // the dots play two different parts either side of the first token.
          //
          // Before the turn paints they ARE the assistant message — nothing
          // else stands in for it — so they keep the full message gap and the
          // first token lands on the line they were holding. Tucking them 12px
          // under the user bubble instead (which is what they used to do) put
          // them 32px above that line, so the instant text arrived they fell
          // 52px: the "extra gap" that appears once streaming starts.
          //
          // Once something HAS painted they are a continuation of it, not a
          // message of their own: cancel the gap and re-add 12px, the same
          // trailing rhythm the tool rows and prose settle at.
          <div className={cn(turnPainted && "-mt-8 pt-3")}>
            <TypingDots />
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
