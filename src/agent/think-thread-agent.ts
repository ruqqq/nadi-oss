import {
  defaultContextOverflowClassifier,
  Think,
  type ChatErrorContext,
  type ChatResponseResult,
  type ContextOverflowConfig,
  type PrepareStepContext,
  type Session,
  type SkillSource,
  type StepConfig,
  type StepContext,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import type { SkillScriptRequest, SkillScriptRunner } from "agents/skills";
import { callable, getAgentByName } from "agents";
import { estimateMessageTokens } from "agents/experimental/memory/utils";
import {
  createInFlightGuard,
  createNadiCompactFunction,
  type CompactionOutcome,
} from "./compaction";
import { estimateTruncatedThreadTokens } from "./thread-history-truncation";
import {
  boundingOptionsFor,
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW,
  resolveContextBudget,
  type ContextBudget,
} from "./context-budget";
import { boundTranscript } from "./transcript-bounding";
import {
  boundContinuity,
  EMPTY_CONTINUITY,
  extractContinuity,
  mergeContinuity,
  renderContinuity,
  type ContinuityIndex,
} from "./continuity-index";
import { resolveContextWindow } from "./context-window";
import {
  flushThreadUsage,
  TurnUsageAccumulator,
  type StepUsage,
  type ThreadUsageIds,
  type UsageSource,
} from "./usage-recorder";
import { generateInternalText } from "./internal-llm";
import { wrapToolsWithOutputCap } from "./tool-output-cap";
import type { AgentMcpOAuthProvider, AgentToolLifecycleResult, AgentToolRunInfo } from "agents";
import {
  APICallError,
  convertToModelMessages,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";
import type { Env } from "../env";
import {
  anyBackgroundWorkEnabled,
  backgroundWorkEnabled,
  type BackgroundCapabilities,
} from "../flags";
import { buildModel } from "../providers/model-factory";
import { invalidatablePromiseCache } from "./promise-cache";
import { chatErrorForClient, serializeErrorChain } from "../error-details";
import {
  buildThreadModelForWorkspace,
  resolveThreadRuntimeConfigForAgent,
} from "./thread-agent-config";
import {
  AUTOMATON_OUTCOME_CONTRACT,
  AUTOMATON_OUTCOME_TOOL_NAME,
  createAutomatonOutcomeTools,
  decideAutomatonTurnEnd,
  type AutomatonRunOutcome,
} from "./automaton-outcome-tool";
import { AttachmentRepository } from "../db/attachment-repository";
import { decideToolPolicy, wrapToolsWithPolicy, type ToolPolicy } from "../mcp/policy";
import { getEnabledMcpServers, getMcpToolPolicyMap } from "../mcp/policy-repo";
import { KvMcpOAuthProvider } from "../mcp/kv-oauth-provider";
import { hasMcpOAuthTokens } from "../mcp/oauth-store";
import {
  getPostHogClient,
  getCachedPostHogClient,
  instrumentModel,
  captureRunError,
  resolveCaptureContent,
} from "../observability/posthog";
import { composeSystemPrompt } from "./system-prompt";
import { autoNameThread, firstUserText } from "./auto-name-thread";
import { resolveMemoryIndex } from "./memory-index";
import { sanitizeOpenAIOAuthMessages } from "./openai-oauth-message-sanitize";
import {
  restoreModelSwitchMarker,
  sanitizeCrossModelReasoning,
  type ModelSwitchOrigin,
} from "./cross-model-reasoning-sanitize";
import {
  extractAttachmentIdsFromModelMessages,
  type ExtractionResult,
  prepareModelMessagesForModel,
} from "./prepare-attachments";
import {
  createAttachmentExtractor,
  type ExtractionStore,
  isExtractionEnabled,
  type WorkersAi,
} from "./attachment-extraction";
import {
  cancelQueuedUserMessageFromBatch,
  normalizeQueuedUserMessageInput,
  serializeQueuedUserMessageSubmissionRows,
  submitQueuedUserMessageBatch,
  type NormalizedQueuedUserMessage,
  type QueuedSubmissionPort,
} from "./queued-user-messages";
import { effectiveModelSwitchRequest } from "./model-switch-request";
import { runAutomatonTurn } from "./automaton-run";
import { buildReasoningProviderOptions } from "./reasoning-options";
import { resolveModelReasoningProfile } from "../providers/model-capabilities";
import { repairOrphanReasoningStream } from "./reasoning-stream-repair";
import {
  buildFeedbackModel,
  FEEDBACK_MODEL_ID,
  FEEDBACK_MODEL_PROVIDER,
  FEEDBACK_SYSTEM_PROMPT,
  selectCurrentFeedbackInterview,
} from "./feedback-mode";
import { reserveFeedbackSlot, type FeedbackRateDecision } from "./feedback-rate-limit";
import { createFeedbackTools } from "./feedback-tools";
import {
  feedbackDiagnosticsSchema,
  feedbackReportFieldsSchema,
  type FeedbackDraftView,
  type FeedbackDiagnostics,
  type FeedbackReportDetail,
  type FeedbackReportFields,
} from "../feedback/types";
import {
  MAX_TOOL_STEPS,
  isFinalToolStep,
  resolveToolStepBudget,
  windDownSystemPrompt,
} from "./tool-step-limit";
import { createBaseNativeThreadTools } from "./thread-tools";
import { createRepositoryPreparation } from "./repository-preparation";
import {
  createComputeTools,
  resolveComputeService,
  adoptCommittedWorkbenchResourceProfile,
  readThreadWorkbenchResourceProfile,
  hasThreadWorkbench,
  scheduleComputeEviction,
  cancelComputeEviction,
  type ComputeToolHostDeps,
} from "./compute-tools";
import {
  createSubagentTools,
  deriveRunLabel,
  formatSubagentCompletion,
  unwrapStoredInputPreview,
  type SubagentRunStatus,
} from "./subagent-tools";
import { SUBAGENT_DETACHED } from "./subagent-config";
import { teardownThreadBeforeDestroy } from "./thread-destroy-teardown";
import { WorkLedgerStore } from "./work-ledger-store";
import { ToolCallTimingStore, type ToolCallTimingRow } from "./tool-call-timing-store";
import { stampToolCallDurations, toolCallIdsIn, wrapToolsWithTiming } from "./tool-call-timing";
import {
  PROCESS_STALE_AFTER_MS,
  REAPER_WORK_REASONS,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_STALE_AFTER_MS,
  UNKNOWN_GENERATION,
  WORK_DELIVERY_RETRY_MS,
  WORK_ROW_RETENTION_MS,
  buildFaultMessage,
  classifyWork,
  nextSweepAt,
  type CurrentGeneration,
  type WorkKind,
  type WorkProgress,
  type WorkOutcome,
  type WorkReason,
  type WorkRow,
  type WorkStopActor,
  type WorkTerminal,
} from "./work-ledger";
import {
  buildSystemReminderMessage,
  buildWatcherCompletionMessage,
  type WatcherCompletionInfo,
} from "./system-reminder";
import type { SandboxCallResult } from "../compute/agent-sandbox-do";
import type { SandboxThreadHost } from "../compute/sandbox-thread-host";
import { buildThreadStartClockReminder, isFirstTurn } from "./thread-start-clock";
import { buildWorkbenchSwitchMessage } from "./workbench-switch-message";
import { InjectionBuffer, type InjectionKind } from "./injection-buffer";
import { assembleStepMessages, routeInjection } from "./injection-router";
import { buildSteeredUserMessage, steeredMessageText } from "./steering-message";
import { createBuiltinSkillSource } from "./skills/builtin-skill-source";
import { createD1SkillSource } from "./skills/d1-skill-source";
import {
  ComputeSkillScriptRunner,
  shouldEnableScriptRunner,
} from "./skills/compute-skill-script-runner";
import { computeProviderReadiness, resolveComputeConfigForAgent } from "../compute/settings";
import { CloudflareComputeBackend, deriveSandboxId } from "../compute/backends/cloudflare";
import { runCloudflareComputeSmoke } from "../compute/backends/cloudflare-smoke";
import { AgentSkillRepository } from "../db/repositories/agent-skills";
import { FeedbackRepository } from "../db/repositories/feedback";
import { WorkspacePrivacySettingsRepository } from "../db/repositories/workspace-privacy-settings";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { ThreadRepository } from "../db/repositories/threads";
import { hasRegistry, registryBinding, registryDb } from "../db/client";
import { resolveThreadModelSnapshotValue } from "../settings/thread-model-snapshot";
import {
  modelSwitchPart,
  readModelSwitchPart,
  sameModelTuple,
  type ModelSwitchData,
} from "./model-switch";
import { attachmentsBucket } from "../storage/bucket-binding";
import { log } from "../log";
import {
  commitWorkbenchSwitchIfPending,
  type WorkbenchSwitchCommitDeps,
} from "./workbench-switch-commit";
import { MIN_STEP_WATCH_AGE_MS, type ThreadComputeService } from "../compute/thread-service";
import type { BackendReference, ComputeSpec } from "../compute/backend";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../compute/watchers";
import { probeWorkspaceCleanliness } from "../compute/workspace-cleanliness";
import { sha256Hex } from "../compute/files/hash";
import {
  PRESIGN_EXPIRES_SECONDS,
  PRESIGN_WINDOW_MS,
  bucketedAnchorMs,
  presignDepsFromEnv,
  presignGet,
} from "../storage/r2-presign";
import { extractPushPreview } from "../notifications/push-preview";
import { recordThreadLifecycleEvent } from "../notifications/thread-notifications";
import { normalizeProseMessage } from "../thread-knowledge/prose-normalizer";
import {
  reconcileThreadSearchProjection,
  scheduleLocalThreadSearchProjection,
} from "../thread-knowledge/projector";
import { grepTranscript, readTranscriptPage } from "../thread-knowledge/transcript-reader";
import {
  THREAD_LAST_MESSAGE_PREVIEW_CHARS,
  THREAD_PROJECTION_DIGEST_PAGE,
  THREAD_PROJECTION_DOCUMENT_BATCH,
  type ActiveTranscriptRpc,
  type InternalGrepRequest,
  type InternalGrepResult,
  type InternalReadRequest,
  type InternalReadResult,
  type RawTranscriptStat,
  type ThreadOrder,
  type ThreadSearchDigest,
  type ThreadSearchDocument,
  type TranscriptSource,
} from "../thread-knowledge/types";

/**
 * Think auto-merges a DO-SQLite-backed virtual filesystem toolset into every
 * turn. `workspaceBash = false` drops only `bash`; the remaining file tools are
 * hidden from the model by excluding these names from the turn's `activeTools`.
 * Kept here (not just relying on `workspaceBash`) so a future Think version that
 * renames or adds a workspace tool fails loudly in tests rather than silently
 * re-exposing filesystem access.
 */
const WORKSPACE_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "list",
  "find",
  "grep",
  "delete",
  "bash",
]);

/** DO storage key for this thread's single, thread-scoped composer draft. */
/**
 * How long a turn will wait for in-flight MCP tool discovery before starting
 * without it. Generous enough for a real remote handshake plus discovery, short
 * enough that an unreachable server costs one turn's tools rather than the turn.
 */
const MCP_DISCOVERY_WAIT_MS = 5_000;

const DRAFT_STORAGE_KEY = "composer:draft";
/**
 * Where the transcript's CURRENT segment begins — the durable twin of the
 * `data-model-switch` marker. The marker lives in the transcript and the
 * transcript is compacted; this record is not, so it is what
 * `restoreModelSwitchMarker` rebuilds segmentation from. Written on every
 * commit, never cleared (the thread always has a current segment once it has
 * switched once).
 */
const MODEL_SWITCH_ORIGIN_STORAGE_KEY = "modelSwitch:origin";
const FEEDBACK_ACTIVE_INTERVIEW_STORAGE_KEY = "feedback:active-interview";
/** Merged continuity index, carried forward across every compaction of a
 *  thread. DO storage, not D1: it is per-thread model context, and it dies with
 *  the thread the same way the transcript does. */
const CONTINUITY_STORAGE_KEY = "compaction:continuity";
const FEEDBACK_DRAFT_STORAGE_KEY = "feedback:draft";
const FEEDBACK_INTERVIEW_BOUNDS_STORAGE_KEY = "feedback:interview-bounds";
const FEEDBACK_DISPATCHED_MESSAGE_IDS_STORAGE_KEY = "feedback:dispatched-message-ids";
const SANDBOX_DECLARED_CLEAN_STORAGE_KEY = "sandbox:declared-clean";
const AUTOMATON_OUTCOME_STORAGE_KEY = "automaton-outcome:pending";
/**
 * Pre-ledger subagent bookkeeping, kept ONLY so
 * {@link ThinkThreadAgent.backfillLegacySubagentRuns} can migrate what is still
 * in flight across the deploy that made the ledger row the lease. A `string[]`
 * of live run ids and a `Record<runId, {startedAt, finishedAt?}>` respectively.
 * Nothing writes these any more; the backfill deletes them.
 */
const LEGACY_SUBAGENT_LEASE_KEY = "subagent:active-runs";
const LEGACY_SUBAGENT_TIMING_KEY = "subagent:run-timing";

/**
 * Parse the legacy timing map defensively. It is old data written by code that
 * no longer exists, read on the alarm path, so every level is treated as
 * untrusted: a malformed map, entry, or timestamp degrades to "no timing for
 * this run" (the backfill then falls back to `now`) and never to a throw.
 */
function readLegacyRunTimings(
  value: unknown,
): Record<string, { startedAt?: number; finishedAt?: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, { startedAt?: number; finishedAt?: number }> = {};
  for (const [runId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const { startedAt, finishedAt } = raw as { startedAt?: unknown; finishedAt?: unknown };
    out[runId] = {
      ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
      ...(typeof finishedAt === "number" && Number.isFinite(finishedAt) ? { finishedAt } : {}),
    };
  }
  return out;
}
const MANUAL_COMPACT_STABLE_TIMEOUT_MS = 1_000;
type CompactionPhase = "idle" | "compacting";
type CompactionSource = "append" | "proactive" | "reactive" | "manual";

/**
 * The single construction site for the thread's compaction function.
 *
 * Hoisted out of `configureSession` so the choice of compaction implementation
 * is itself testable: the SDK's `createCompactFunction` renders object-shaped
 * tool outputs to the summarizer as "[object Object]", and nothing but a test
 * through this seam stops a revert or a bad merge from silently restoring it.
 * See `test/unit/agent/thread-compaction-wiring.test.ts`.
 */
/**
 * The manual-compaction result. `reason` exists so the client can label the
 * divider without parsing `message`: a decline and a genuine no-op both report
 * `compacted: false`, and collapsing them made the divider read "No compaction
 * needed" while the toast said the opposite.
 */
export type CompactThreadOutcome = {
  compacted: boolean;
  reason?: "declined" | "not-needed";
  message: string;
};

export function createThreadCompaction(deps: {
  budget: ContextBudget;
  summarize: (prompt: string) => Promise<string>;
  onOutcome: (outcome: CompactionOutcome) => void;
  continuityBlock?: string;
  allowReset?: boolean;
}) {
  return createNadiCompactFunction(deps);
}

/**
 * A backend reference carried across the `parentAgent()` RPC boundary. The
 * payload is typed as a flat serializable record because Cloudflare's
 * `Rpc.Serializable` rejects the default `unknown` payload (which would silently
 * degrade the RPC return type to `never`); a non-recursive type also keeps the
 * serializability check from exploding. All backend reference payloads are flat
 * string maps at runtime (see the provider reference schemas).
 */
export type SerializableBackendReference = BackendReference<
  Record<string, string | number | boolean | null>
>;

/** Trusted context a shared-compute subagent pulls from its parent via `parentAgent()`. */
export interface SubagentContext {
  parentThreadId: string;
  workspaceId: string;
  agentId: string;
  /** The parent's live compute environment reference the child attaches to. */
  attachedRuntime: SerializableBackendReference;
}

/** Result of one reaper pass over the background work ledger (see `runWorkLedgerSweep`). */
export interface WorkSweepResult {
  classified: Array<{ id: string; state: string; reason?: string }>;
  terminalized: string[];
  /** Ids whose terminal was owed a delivery from an earlier pass and got it. */
  redelivered: string[];
}

interface WebToolHostDeps {
  env: Env;
  threadId: string;
  storage: DurableObjectStorage;
  resolveRuntimeConfig: () => Promise<{ workspaceId: string }>;
}

interface FeedbackActiveInterview {
  interviewId: string;
  fromMessageId: string;
}

interface FeedbackInterviewBounds {
  interviewId: string;
  fromMessageId: string;
  toMessageId: string;
}

type FeedbackDraftStorage = FeedbackDraftView & {
  fromMessageId: string;
  toMessageId: string;
};

interface FeedbackDraftInput extends FeedbackReportFields {
  attachmentIds: string[];
}

export type SubmitFeedbackDraftResult =
  | { ok: true; created: boolean; report: FeedbackReportDetail }
  | { ok: false; reason: "stale_draft" }
  | { ok: false; reason: "idempotency_collision" }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

function feedbackDraftView(draft: FeedbackDraftStorage): FeedbackDraftView {
  return {
    id: draft.id,
    interviewId: draft.interviewId,
    fields: draft.fields,
    attachmentIds: draft.attachmentIds,
    createdAt: draft.createdAt,
  };
}

function modelMessageText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Fallback for terminal rows written before `WorkTerminal.exitCode` existed:
 * `reportProcessCompletion`'s `detail` string (`"exit code 7"`) is the only
 * place the code survives on those rows. This is the ONE place in the
 * codebase that ever parses it back out of prose — `listBackgroundWork` is
 * the sole caller, and every write going forward stamps the structured field
 * directly (`reportProcessCompletion`, `pollWatcher`) instead of relying on
 * this. Returns `null` for anything that doesn't match, same as "no exit code
 * known" for a fault/timeout/stop.
 */
function parseExitCodeFromDetail(detail: string): number | null {
  const match = /^exit code (-?\d+)$/.exec(detail);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The SDK `AgentToolLifecycleResult.status` values a `subagent` row's terminal
 * can carry. `onAgentToolFinish` writes `result.status` VERBATIM into
 * `WorkTerminal.detail`, so for a subagent row the detail string is already
 * this closed set rather than prose — unlike a `process` row, whose detail is
 * `"exit code 7"`.
 *
 * This exists because a subagent's `WorkOutcome` cannot tell success from
 * failure on its own: `onAgentToolFinish` maps only `aborted` to `"stopped"`,
 * so `completed`, `error` AND `interrupted` all land as `"exited"`. A UI toning
 * a row on `outcome` alone therefore paints a crashed subagent as a clean one.
 * `exitCode` cannot cover the gap either — a subagent never has one, which is
 * exactly why the dock read every finished subagent as a FAILURE (an absent
 * code is an unconfirmed exit for a process, but the normal case for a
 * subagent).
 */
const SUBAGENT_TERMINAL_STATUSES = ["completed", "error", "aborted", "interrupted"] as const;
export type SubagentTerminalStatus = (typeof SUBAGENT_TERMINAL_STATUSES)[number];

/**
 * Validate a `subagent` row's `detail` into {@link SubagentTerminalStatus}.
 *
 * Validated HERE, server-side, rather than shipping `detail` to the client for
 * it to interpret: this codebase's rule is that a client switches on a typed
 * field, never on prose (see `WorkTerminal.exitCode`'s doc, added for the same
 * reason). `null` for an unrecognized value — a row written by a future SDK
 * status, or a `process` row's `"exit code 7"` — and the UI must treat that as
 * "outcome unknown", never as success.
 */
function subagentStatusFromDetail(detail: string): SubagentTerminalStatus | null {
  return (SUBAGENT_TERMINAL_STATUSES as readonly string[]).includes(detail)
    ? (detail as SubagentTerminalStatus)
    : null;
}

function modelMessageId(message: { id?: unknown }): string | null {
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function trailingUserMessageIds(messages: Array<{ id?: unknown; role?: unknown }>): string[] {
  const ids: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") break;
    const id = modelMessageId(message);
    if (id) ids.unshift(id);
  }
  return ids;
}

// `implements SandboxThreadHost` is the only compile-time check on the sandbox
// back-call contract: `createSandboxThreadHostDeps` reaches this class through
// an unchecked `as unknown as SandboxThreadHost` cast (a DO stub cannot be
// typed as the class), so a signature drift would otherwise be invisible.
export class ThinkThreadAgent extends Think<Env> implements SandboxThreadHost {
  workspaceBash = false;
  /** Cap on concurrent non-terminal agent-tool runs this thread may own at once (shared-sandbox subagents). */
  maxConcurrentAgentTools = 4;
  /** @internal for tests only — overrides this.mcp.getAITools() */
  _testToolOverride?: ToolSet;
  /** @internal for tests only — the in-flight auto-naming handed to waitUntil */
  _autoNameForTest?: Promise<void>;
  /** @internal for tests only — overrides D1 getMcpToolPolicyMap() lookup */
  _testPolicyMap?: Record<string, ToolPolicy>;
  /** @internal for tests only — captures Think's fully assembled pre-hook tool set */
  _lastBeforeTurnToolNamesForTest?: string[];
  /** @internal for tests only — captures the post-policy `activeTools` allowlist */
  _lastBeforeTurnActiveToolsForTest?: string[] | undefined;
  /** @internal for tests only — shrinks MAX_TOOL_STEPS so wind-down is testable without looping the full budget */
  _testMaxToolSteps?: number | undefined;
  /** Composed system prompt of the in-flight turn, reused by the wind-down step. */
  private currentTurnWindDownSystem?: string;
  /**
   * Resolved tool-step budget of the in-flight turn (50 or the coding-work 500).
   * Stashed in `beforeTurn` because `beforeStep` is synchronous and must wind
   * down at the SAME budget the turn started on, not recompute a default.
   */
  private currentTurnMaxSteps?: number;
  /** Resolved workbench presence of the in-flight turn, stashed alongside
   *  `currentTurnMaxSteps` so `beforeStep` can log the wind-down without
   *  re-deriving it (the D1 lookup that produced it is async; `beforeStep` is not). */
  private currentTurnHasWorkbench?: boolean;
  private _cachedWorkspaceId?: string;
  /** Memoized MCP connect-readiness. Kicked in the background from `onStart` and
   *  awaited in `beforeTurn` so remote MCP handshakes never block the WS
   *  handshake or `/get-messages`. Cleared on failure so a later turn retries. */
  private _mcpReady: Promise<void> | null = null;
  /** Single-slot cache for the thread's runtime config (a D1 join + project
   *  lookup). Before this, a cold wake re-ran that query 5-7 times
   *  (`configureSession`, `seedCompactAfterTokens`, MCP warm-up, OAuth) — ~1.5s
   *  of the ~2.2s cold-open latency. `beforeTurn` invalidates it so each turn
   *  still reads fresh config (model/project changes apply on the next turn). */
  private _runtimeConfig = invalidatablePromiseCache(async () => {
    const config = await resolveThreadRuntimeConfigForAgent(this.env, this.name);
    if (!config) {
      throw new Error(`think_thread_not_registered:${this.name}`);
    }
    return config;
  });
  private _skillScriptRunner: SkillScriptRunner | null = null;
  private currentTurnSetupReminders: ModelMessage[] | undefined;
  private currentTurnStartedAt: number | null = null;
  currentTurnTelemetryEnabled: boolean | undefined;
  private currentTurnAttentionRequiredRecorded = false;
  private currentTurnTrace:
    | {
        workspaceId: string;
        provider: string;
        model: string;
        traceId: string;
      }
    | undefined;
  /** Which entry point triggered the compaction currently being attempted. An
   * explicit field, not a boolean two writers race on: the append threshold, the
   * overflow guards and the manual route all funnel into the same handler. */
  private _compactionSource: CompactionSource = "append";
  /** Collapses overlapping compaction attempts onto ONE summarizer run: a DO is
   * single-threaded but not atomic across awaits, so an RPC or steering append
   * delivered while `compact()` awaits the LLM would re-check the threshold, see
   * nothing written yet, and compact again. */
  private _compactionGuard = createInFlightGuard();
  /** Threshold currently armed on the session, so `beforeTurn` only re-arms when
   * the resolved budget actually changed. */
  private _armedCompactAfter: number | null = null;
  private _lastCompactionOutcome: CompactionOutcome | null = null;
  private compactionPhase: CompactionPhase = "idle";

  /** Read-and-clear the outcome of the last compaction attempt. */
  private takeLastCompactionOutcome(): CompactionOutcome | null {
    const outcome = this._lastCompactionOutcome;
    this._lastCompactionOutcome = null;
    return outcome;
  }
  private _injectionBuffer?: InjectionBuffer;
  private workLedgerInstance?: WorkLedgerStore;
  /** Stop attributions awaiting their SDK terminal; see `cancelSubagentRun`. */
  private pendingStopActors?: Map<string, WorkStopActor>;
  private toolCallTimingInstance?: ToolCallTimingStore;
  /** One-shot legacy lease migration; see `ensureLegacySubagentBackfill`. */
  private legacyBackfillPromise?: Promise<void>;
  private _activeTurnInjections: ModelMessage[] = [];
  /** Sandbox service resolved once per turn in `beforeTurn` (resolveComputeService
   *  is expensive), reused by the per-step auto-watch sweep in `beforeStep` so a
   *  long-running process gets a watcher mid-turn instead of only at turn end. */
  private _turnSandboxService: ThreadComputeService | null = null;
  private _contextBudget: { key: string; budget: ContextBudget } | null = null;
  /** The runtime config `beforeTurn` already resolved for the turn in flight.
   * Session runs the compaction tokenCounter on EVERY appendMessage/updateMessage,
   * and that counter needs the budget — so without this, a tool-heavy turn paid an
   * uncached D1 read per persisted message. Held only for the duration of a turn:
   * the first append of the NEXT turn (which precedes its `beforeTurn`) re-reads,
   * so a mid-thread model switch is still picked up. */
  private _turnRuntimeConfig: Awaited<
    ReturnType<ThinkThreadAgent["resolveRuntimeConfigForThink"]>
  > | null = null;

  /** Memoized `modelSwitch:origin` record. `undefined` means "not read yet";
   *  `null` means "read, and this thread has never switched". */
  private _modelSwitchOrigin: ModelSwitchOrigin | null | undefined = undefined;

  /**
   * Usage for the turn in flight. In-memory ONLY: `onStepFinish` runs BETWEEN
   * model steps, so anything it awaits is latency the user feels on every step
   * of every tool loop. Drained once, at turn end, by {@link flushTurnUsage}.
   */
  protected turnUsage = new TurnUsageAccumulator();
  /**
   * The context window of the model this turn runs on, stashed in `beforeTurn`
   * (which already resolves the budget) so the hot path can read it without I/O.
   */
  private _currentContextWindow: number | undefined;
  /**
   * The compaction trigger this turn runs with, stashed beside the window (same
   * budget, same reason: the hot path must not resolve it). Persisted with the
   * gauge so the client can warn at the REAL threshold instead of re-deriving it.
   */
  private _currentCompactAfterTokens: number | undefined;
  /**
   * Serializes turn-usage flushes. Both `onChatError` and `onChatResponse` can
   * fire for the SAME failed turn (Think fires the response hook with
   * `status: "error"` when an assistant part was persisted), and `onChatError`
   * cannot await. Chaining keeps two flushes from racing a second write in.
   */
  private _usageFlush: Promise<void> | null = null;
  /**
   * Whether this thread's steps describe THIS thread's context gauge. `SubAgent`
   * overrides it to `false`: a subagent's context is not the parent thread's, and
   * writing it to the parent's `thread_index` gauge would corrupt it.
   */
  protected tracksContextGauge = true;

  /**
   * Which `UsageSource` bucket a per-step usage add() lands in. Synchronous —
   * this runs on the `onStepFinish` hot path (no I/O). `flushThreadUsage` keys
   * the ledger row's `source` column off each accumulator ENTRY, not off
   * `usageAttribution()`'s return value, so this is the seam that actually
   * controls the persisted label. `SubAgent` overrides it to `"subagent"` so
   * its spend stays separable from the parent's own chat spend in the ledger.
   */
  protected turnUsageSource(): UsageSource {
    return "chat";
  }

  /**
   * Which bucket a COMPACTION's summarizer call lands in. The attribution rule,
   * stated once: a subagent's spend is the parent thread's spend, tagged
   * `subagent` — ALL of it, including the compaction a subagent's own context
   * triggers. `SubAgent` therefore overrides this to `"subagent"`, so a
   * subagent's compaction can never merge into the parent's own `compaction` row
   * (same unique key) and make the two indistinguishable.
   */
  protected compactionUsageSource(): UsageSource {
    return "compaction";
  }

  /**
   * Which thread this turn's tokens belong to. The seam `SubAgent` overrides: a
   * subagent's spend is the PARENT thread's spend. The provider/model/source of
   * each row come from the accumulator ENTRIES (see `turnUsageSource` /
   * `compactionUsageSource`), never from here.
   *
   * Reads the turn-pinned config when there is one (turn end, before the pin is
   * dropped); falls back to a fresh resolve on the error path, where the pin has
   * already been cleared.
   */
  protected async usageAttribution(): Promise<ThreadUsageIds> {
    const config = this._turnRuntimeConfig ?? (await this.resolveRuntimeConfigForThink());
    return {
      threadId: this.name,
      workspaceId: config.workspaceId,
      agentId: config.agentId,
    };
  }

  /**
   * Turn-end drain. Never throws — a lost usage row must not fail a turn the
   * user already paid for.
   *
   * SNAPSHOT-AND-SWAP, and the swap is SYNCHRONOUS on purpose. The DO is
   * single-threaded but not atomic across awaits: while a flush is parked on D1,
   * `onStepFinish` for the NEXT turn can run and record usage. If the flush
   * cleared the shared accumulator after its await (what `reset()` used to do),
   * that usage — and its gauge reading — would be silently wiped. Swapping in a
   * fresh accumulator BEFORE the first await hands the flush a private object and
   * gives later steps somewhere safe to land.
   */
  protected flushTurnUsage(): Promise<void> {
    const pending = this.turnUsage;
    if (pending.isEmpty()) return this._usageFlush ?? Promise.resolve();
    this.turnUsage = new TurnUsageAccumulator();

    const next = (this._usageFlush ?? Promise.resolve()).then(async () => {
      let persisted = false;
      try {
        const ids = await this.usageAttribution();
        persisted = await flushThreadUsage(this.env, ids, pending);
      } catch (error) {
        log.warn("think_thread.usage_flush_failed", {
          threadId: this.name,
          error: String(error),
        });
      }
      // Nothing was written (a failed batch is a failed transaction), so put the
      // snapshot back for the next flush to retry. `pending` is private to this
      // flush and is dropped here, so the retry cannot double-count.
      if (!persisted) this.turnUsage.merge(pending);
    });
    this._usageFlush = next;
    return next;
  }

  /**
   * The hot path. Pure in-memory arithmetic, no I/O: this runs BETWEEN model
   * steps, and anything awaited here is latency on every step of every tool loop.
   * The turn's provider/model and context window are already pinned by
   * `beforeTurn`, so attribution costs nothing here.
   */
  override onStepFinish(ctx: StepContext): void {
    const pinned = this._turnRuntimeConfig;
    if (!pinned) return;
    const usage = ctx.usage as StepUsage | undefined;
    if (!usage) return;
    const { provider, model } = pinned.modelConfig;

    this.turnUsage.add(
      { provider, model, source: this.turnUsageSource() },
      usage,
      ctx.providerMetadata,
    );

    // The gauge: the real size of the context we just sent. It overwrites, so a
    // turn that compacts mid-flight ends up reporting the POST-compaction size.
    const window = this._currentContextWindow;
    if (this.tracksContextGauge && typeof window === "number") {
      this.turnUsage.recordContext(provider, usage, window, this._currentCompactAfterTokens);
    }
  }

  /** The budget for the thread's CURRENT model. Memoized per provider+model so a
   * mid-thread model switch re-derives it (the model is switchable per thread and
   * per automaton). */
  private async currentContextBudget(): Promise<ContextBudget> {
    const config = this._turnRuntimeConfig ?? (await this.resolveRuntimeConfigForThink());
    const { provider, model } = config.modelConfig;
    const key = `${provider}:${model}`;
    if (this._contextBudget?.key === key) return this._contextBudget.budget;
    const budget = resolveContextBudget(resolveContextWindow({ provider, model, env: this.env }));
    this._contextBudget = { key, budget };
    // Think fires the proactive guard at `maxInputTokens * (headroom ?? 0.9)`;
    // `proactiveInputTokens` IS the trigger the budget derived, so headroom is 1.
    this.contextOverflow = {
      reactive: true,
      // 2, not 1: the compaction ladder can spend an attempt on a span that
      // fails the shrink check before the reset lands, and a later trigger puts
      // more compactions inside a turn. At 1 the guard aborts the ladder at its
      // first rung, which is the case the reset exists to survive.
      proactive: { maxInputTokens: budget.proactiveInputTokens, headroom: 1, maxCompactions: 2 },
    };
    return budget;
  }

  /**
   * Both overflow layers. Think declares `contextOverflow` as a PROPERTY, so an
   * accessor override trips TS2611 — instead the proactive threshold is (re)set
   * from the resolved budget in {@link currentContextBudget}, which is the same
   * "follows the thread's CURRENT model" behavior a getter would have given (the
   * model is switchable per thread and per automaton). The reactive backstop is
   * on from the start; it needs no budget.
   */
  override contextOverflow: ContextOverflowConfig = { reactive: true };

  /** `reactive` is a no-op without a classifier — Think never matches provider
   * error strings itself. */
  override classifyChatError = defaultContextOverflowClassifier;

  getModel(): LanguageModel {
    return buildModel({ provider: "mock", model: "mock", apiKey: "" });
  }

  getSystemPrompt(): string {
    return "You are running the Nadi Think migration spike.";
  }

  getTools(): ToolSet {
    // Think's tool hook is synchronous, so only the always-on native tools are
    // registered here. The config-aware `exec_*` sandbox tools are composed
    // asynchronously in `beforeTurn` (and gated via `activeTools`) instead.
    return {
      ...createBaseNativeThreadTools({
        env: this.env,
        threadId: this.name,
        resolveThreadKnowledgeScope: async () => {
          const config = await this.resolveRuntimeConfigForThink();
          return { workspaceId: config.workspaceId, callerThreadId: this.name };
        },
      }),
    };
  }

  async getSkills(): Promise<SkillSource[]> {
    const config = await this.resolveRuntimeConfigForThink();
    const sources: SkillSource[] = [
      createBuiltinSkillSource({
        backgroundExec: config.backgroundExecEnabled,
        subagents: config.subagentsEnabled,
      }),
      createD1SkillSource({
        env: this.env,
        threadId: this.name,
        resolveRuntimeConfig: async () => {
          const config = await this.resolveRuntimeConfigForThink();
          return { workspaceId: config.workspaceId, agentId: config.agentId };
        },
      }),
    ];
    // Resolve the script-runner gate (async) and cache it for the synchronous
    // getSkillScriptRunner() the SDK calls immediately after this resolves.
    this._skillScriptRunner = await this.resolveSkillScriptRunner();
    return sources;
  }

  /** Non-null only when the sandbox is enabled AND some enabled skill has a script. */
  private async resolveSkillScriptRunner(): Promise<SkillScriptRunner | null> {
    try {
      const { workspaceId, agentId } = await this.resolveRuntimeConfigForThink();
      const repo = new AgentSkillRepository(registryDb(this.env));
      // Both are D1 round-trips (~220ms each from inside the DO) and neither
      // depends on the other's data — only on workspaceId/agentId. Serially they
      // doubled the cold-wake skills cost. `hasEnabledScriptSkill` is a read, so
      // running it even when compute is disabled is harmless (result discarded).
      // The thread's frozen workbench profile must be threaded through here the
      // same way `resolveComputeService` does it. Resolving against the default
      // `small` on a workspace whose Daytona config sets only a `medium` source
      // yields `missing_source` -> `enabled === false`, which disabled the
      // skill-script runner for EVERY thread — including medium-workbench
      // threads whose exec tools resolve fine.
      const [workbenchResourceProfile, hasEnabledScript] = await Promise.all([
        readThreadWorkbenchResourceProfile(this.env, this.name),
        repo.hasEnabledScriptSkill({ workspaceId, agentId }),
      ]);
      const config = await resolveComputeConfigForAgent({
        env: this.env,
        workspaceId,
        agentId,
        workbenchResourceProfile,
      });
      const hasScript = config.enabled ? hasEnabledScript : false;
      if (!shouldEnableScriptRunner(config.enabled, hasScript) || !config.enabled) return null;
      return new ComputeSkillScriptRunner({
        getService: async () => {
          const resolved = await resolveComputeService(this.sandboxHostDeps());
          return resolved ? resolved.service : null;
        },
        allowlist: config.value.allowedHosts,
        threadId: this.name,
      });
    } catch (error) {
      log.warn("skill_script_runner.resolve_failed", { threadId: this.name, error: String(error) });
      return null;
    }
  }

  getSkillScriptRunner(): SkillScriptRunner | null {
    return this._skillScriptRunner;
  }

  private async resolveWorkspaceIdForOAuth(): Promise<string | undefined> {
    if (this._cachedWorkspaceId) return this._cachedWorkspaceId;
    try {
      this._cachedWorkspaceId = (await this.resolveRuntimeConfigForThink()).workspaceId;
      return this._cachedWorkspaceId;
    } catch {
      return undefined;
    }
  }

  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new KvMcpOAuthProvider(this.ctx.storage, callbackUrl, this.env, () =>
      this.resolveWorkspaceIdForOAuth(),
    );
  }

  async onStart(): Promise<void> {
    try {
      const config = await this.resolveRuntimeConfigForThink();
      if (config.kind === "feedback") return;
    } catch (error) {
      if (!String(error).includes("think_thread_not_registered:")) throw error;
      return;
    }
    // Connecting MCP servers is a remote handshake per server; awaiting it here
    // would block `blockConcurrencyWhile(onStart)` and, behind it, the WS
    // handshake and `/get-messages` — the exact cost that made cold thread opens
    // take seconds. Kick it in the background instead; `beforeTurn` awaits the
    // same memoized promise so the first turn's tool set is still complete.
    this.ctx.waitUntil(this._ensureMcpServers());
  }

  /** Connect every enabled MCP server exactly once per DO lifetime. Kicked
   *  eagerly in `onStart`, awaited in `beforeTurn`. On failure the memo is
   *  cleared so a later turn retries (matching the old re-init-on-throw). */
  private _ensureMcpServers(): Promise<void> {
    if (!this._mcpReady) {
      this._mcpReady = this._connectEnabledMcpServers().catch((error) => {
        this._mcpReady = null;
        throw error;
      });
    }
    return this._mcpReady;
  }

  private async _connectEnabledMcpServers(): Promise<void> {
    let config: Awaited<ReturnType<typeof this.resolveRuntimeConfigForThink>>;
    try {
      config = await this.resolveRuntimeConfigForThink();
    } catch (error) {
      if (String(error).includes("think_thread_not_registered:")) return;
      throw error;
    }
    const workspaceId = config.workspaceId;
    this._cachedWorkspaceId = workspaceId;
    const servers = await getEnabledMcpServers(this.env, workspaceId);
    // Parallel, not serial: each server has a distinct id, so the worst-case
    // first-turn wait is the slowest single handshake, not their sum. Per-server
    // errors are swallowed below, so this never rejects on a connection failure.
    await Promise.all(servers.map((server) => this._connectMcpServer(workspaceId, server)));
  }

  private async _connectMcpServer(
    workspaceId: string,
    server: Awaited<ReturnType<typeof getEnabledMcpServers>>[number],
  ): Promise<void> {
    let hasTokens = false;
    try {
      hasTokens = await hasMcpOAuthTokens(this.env, workspaceId, server.id);
    } catch {
      hasTokens = false;
    }
    try {
      const result = await this.addMcpServer(server.name, server.url, {
        id: server.id,
        transport: { type: "streamable-http" },
        ...(hasTokens ? { callbackHost: this.env.APP_BASE_URL } : {}),
      });
      if ((result as { state?: string }).state === "authenticating") {
        log.info("think_thread.mcp_skipped_unauthorized", { workspaceId, serverId: server.id });
        await this.removeMcpServer(server.id);
      }
    } catch (error) {
      log.warn("think_thread.mcp_server_skipped", {
        workspaceId,
        serverId: server.id,
        error: String(error),
      });
      try {
        await this.removeMcpServer(server.id);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  /**
   * The compaction trigger to arm before the session can see a single message.
   *
   * Not a placeholder: Session runs its auto-compaction check INSIDE
   * `appendMessage`, and Think appends the user message before `beforeTurn` runs
   * — so on the first append after every cold start or DO eviction, whatever is
   * armed here is the threshold that decides. A flat seed compacted a 694k-budget
   * thread at 100k, discarding context it was entitled to keep, and let a
   * small-window thread start its turn over budget.
   */
  private async seedCompactAfterTokens(): Promise<number> {
    try {
      return (await this.currentContextBudget()).compactAfterTokens;
    } catch (error) {
      // A thread with no registry row has no model to derive a budget from (the
      // same case `onStart` tolerates). Fall back to the unknown-model budget —
      // `beforeTurn` re-arms once the row exists.
      log.warn("think_thread.compact_after_seed_fallback", {
        threadId: this.name,
        error: String(error),
      });
      return resolveContextBudget(DEFAULT_CONTEXT_WINDOW).compactAfterTokens;
    }
  }

  async configureSession(session: Session): Promise<Session> {
    let configured = session
      .withContext("soul", {
        provider: {
          get: async () => {
            const config = await this.resolveRuntimeConfigForThink();
            return config.modelConfig.systemPrompt;
          },
        },
      })
      .withContext("memory", {
        description: "Important facts learned during this Nadi thread.",
        maxTokens: 2000,
      });
    const role = this.sessionRoleContext();
    if (role) {
      configured = configured.withContext(role.name, {
        provider: { get: async () => role.text },
      });
    }
    return this.guardSessionCompact(
      configured
        .withCachedPrompt()
        // Nadi's own compaction function, not the SDK's: the SDK renders
        // object-shaped tool outputs to the summarizer as "[object Object]", puts no
        // upper bound on the summary, and reports a failed summarizer as "nothing to
        // compact".
        // No guard here: `guardSessionCompact` wraps `compact()` itself, which is the
        // outer call. Guarding again inside would be re-entrant — the inner call
        // would await the outer promise, which is waiting on it.
        .onCompaction(async (messages) => {
          return (async () => {
            this.compactionPhase = "compacting";
            try {
              const config = await this.resolveRuntimeConfigForThink();
              const budget = await this.currentContextBudget();
              const source = this._compactionSource;
              // Computed, never generated: a summarizer under context pressure
              // drops bookkeeping first, and bookkeeping is what stops the next
              // turn redoing finished work. Extracted from the FULL history the
              // SDK handed us — not the selected middle — so a span already
              // shadowed by an earlier checkpoint still contributes, and merged
              // with what previous checkpoints knew (pi's CompactionDetails).
              const continuity = boundContinuity(
                mergeContinuity(
                  (await this.ctx.storage.get<ContinuityIndex>(CONTINUITY_STORAGE_KEY)) ??
                    EMPTY_CONTINUITY,
                  extractContinuity(messages as unknown as { parts?: unknown }[]),
                ),
                // A quarter of the summary budget: the block lives INSIDE the
                // post-compaction floor, so it cannot be allowed to grow with
                // the thread.
                Math.floor((budget.maxSummaryTokens * CHARS_PER_TOKEN) / 4),
              );
              await this.ctx.storage.put(CONTINUITY_STORAGE_KEY, continuity);
              const compact = createThreadCompaction({
                budget,
                continuityBlock: renderContinuity(continuity),
                // A manual `/compact` must never discard the transcript: the
                // user asked to shrink the thread, not to lose it. Only
                // automatic pressure — where the alternative is a failed turn —
                // may fall through to the reset.
                allowReset: source !== "manual",
                summarize: async (prompt) => {
                  // Streams, and falls back to a keyless Workers AI model if the
                  // thread's own model cannot serve the call. A summarizer that
                  // cannot run means a thread that can never compact — it just
                  // grows until the provider rejects it. See internal-llm.ts.
                  const result = await generateInternalText({
                    env: this.env,
                    purpose: "compaction_summary",
                    primaryProvider: config.modelConfig.provider,
                    primaryModel: config.modelConfig.model,
                    buildPrimary: () =>
                      buildThreadModelForWorkspace(
                        this.env,
                        config.modelConfig,
                        config.workspaceId,
                      ),
                    system:
                      "Compact this Nadi thread for future model context. Preserve key facts, decisions, open tasks, tool outcomes, current user intent, and the next likely action. Do not invent details.",
                    prompt,
                    // Bounded: this runs MID-TURN on the thread's own model.
                    maxOutputTokens: budget.maxSummaryTokens,
                  });
                  // Compaction is NOT free: it is a real, billed model call, and a
                  // FAILED primary attempt that fell back to Workers AI burned real
                  // tokens too — so record every attempt against the model that
                  // actually ran it, not just the one whose text we kept. Mid-turn,
                  // so this folds into the turn's accumulator (flushed once at turn
                  // end) rather than writing to D1 here. Deliberately no
                  // `recordContext`: a summarizer call is not the thread's context.
                  const compactionSource = this.compactionUsageSource();
                  for (const attempt of result.attempts) {
                    this.turnUsage.add(
                      {
                        provider: attempt.provider,
                        model: attempt.model,
                        source: compactionSource,
                      },
                      attempt.usage,
                    );
                  }
                  return result.text;
                },
                onOutcome: (outcome) => {
                  this._lastCompactionOutcome = outcome;
                  const base = {
                    threadId: this.name,
                    workspaceId: config.workspaceId,
                    agentId: config.agentId,
                    runtime: "think",
                    source,
                    messageCount: messages.length,
                    contextWindow: budget.contextWindow,
                    compactAfterTokens: budget.compactAfterTokens,
                  };
                  if (outcome.status === "failed") {
                    // Session.compact() swallows the throw and returns null, so
                    // onCompactionError never fires — this is the only place a failed
                    // summarizer becomes visible.
                    log.warn("think_thread.compaction_failed", { ...base, error: outcome.error });
                  } else if (outcome.status === "noop") {
                    log.info("think_thread.compacted", {
                      ...base,
                      outcome: outcome.status,
                      reason: outcome.reason,
                    });
                  } else if (outcome.status === "declined") {
                    // Not a failure and not a no-op: a manual compaction that
                    // would only have converged by discarding history.
                    log.info("think_thread.compaction_declined", {
                      ...base,
                      reason: outcome.reason,
                    });
                  } else if (outcome.status === "reset") {
                    // A reset DISCARDS transcript the model was still using. It
                    // is recoverable but lossy, so it must never pass silently.
                    log.warn("think_thread.compaction_reset", {
                      ...base,
                      discardedMessages: outcome.discardedMessages,
                      reason: outcome.reason,
                    });
                  } else if (outcome.status === "retried") {
                    // Not a failure: the first span's summary did not shrink it,
                    // so the range widened and the summarizer ran again. Visible
                    // because it is a second billed call on the thread's model.
                    log.info("think_thread.compaction_retried", {
                      ...base,
                      attempt: outcome.attempt,
                      reason: outcome.reason,
                    });
                  } else {
                    log.info("think_thread.compacted", {
                      ...base,
                      outcome: outcome.status,
                      summarizedMessages: outcome.summarizedMessages,
                      summaryTokens: outcome.summaryTokens,
                    });
                  }
                },
              });
              return await compact(messages);
            } catch (error) {
              // Anything thrown BEFORE the summarize call (config/budget resolution)
              // escapes createNadiCompactFunction's own catch; Session.compact() then
              // swallows it and returns null, and compactThread() would report the
              // failure as the misleading "Nothing to compact yet." Record it as a
              // failure so a genuine no-op and a broken run stay distinguishable.
              const message = error instanceof Error ? error.message : String(error);
              this._lastCompactionOutcome = { status: "failed", error: message };
              log.warn("think_thread.compaction_failed", {
                threadId: this.name,
                runtime: "think",
                source: this._compactionSource,
                error: message,
              });
              return null;
            } finally {
              this.compactionPhase = "idle";
            }
          })();
        })
        .compactAfter(await this.seedCompactAfterTokens(), {
          // Count the TRUNCATED payload (older tool outputs shrunk exactly as the
          // model-facing view shrinks them) so the auto-compaction trigger tracks
          // what the model is actually sent — not the raw stored size. Without
          // this, a few huge tool outputs pin the estimate above the threshold and
          // compaction fires every turn without ever shortening history.
          //
          // configureSession runs only once (in onStart), so `beforeTurn` re-arms
          // the threshold whenever the resolved budget changes — otherwise a
          // mid-thread model switch would keep compacting at the old model's
          // trigger.
          tokenCounter: async ({ messages, systemPrompt }) =>
            estimateTruncatedThreadTokens({
              messages,
              systemPrompt,
              budget: await this.currentContextBudget(),
            }),
        })
        .onCompactionError((error) => {
          log.warn("think_thread.compaction_failed", {
            threadId: this.name,
            error: String(error),
          });
        }),
    );
  }

  /**
   * Collapse overlapping compactions onto ONE run — including the row write.
   *
   * A DO is single-threaded but not atomic across awaits: the input gate only
   * defers events while a STORAGE op is outstanding, and Session uses the
   * synchronous SQLite API. So while `compact()` awaits the summarizer (seconds),
   * the runtime can deliver an append, a steering message, or a watcher RPC whose
   * own append re-checks the threshold and calls `compact()` again.
   *
   * Guarding only the compaction FUNCTION (as we first did) collapses the
   * summarizer call but NOT the row write: each `Session.compact()` still runs
   * `addCompaction` afterwards, so N racing calls leave N redundant overlay rows.
   * They share an anchor and so still render as one summary, but they are wasted
   * writes and they make the stored state hard to reason about — a live thread was
   * found holding three rows where one would do. Wrapping `compact()` itself is
   * what actually makes it one operation.
   */
  private guardSessionCompact(session: Session): Session {
    const target = session as unknown as { compact: () => Promise<unknown> };
    const original = target.compact.bind(session);
    target.compact = () => this._compactionGuard(original);
    return session;
  }

  async beforeTurn(_ctx: TurnContext): Promise<TurnConfig> {
    await this.assertThreadWritable();
    // Config is frozen within a turn but must refresh between turns (a mid-thread
    // model or project change). Drop the per-wake cache so this turn's first
    // resolve is fresh; the onStart burst and idle status reads still share one
    // cached D1 query.
    this._runtimeConfig.invalidate();
    // Commit any model switch the client requested on the message(s) that
    // triggered this turn, BEFORE the resolve below, so this turn (not the
    // next one) runs on the newly chosen model. See `commitPendingModelSwitch`
    // for why this position makes the Anthropic thinking/tool_use ordering
    // rule unreachable.
    await this.commitPendingModelSwitch();
    // Reset only — draining happens in `beforeStep` (see its comment for why
    // draining here would duplicate messages between the base and injections).
    this._activeTurnInjections = [];
    this._lastBeforeTurnToolNamesForTest = Object.keys(_ctx.tools).sort();
    const runtimeConfig = await this.resolveRuntimeConfigForThink();
    this._turnRuntimeConfig = runtimeConfig;
    if (runtimeConfig.kind === "feedback") {
      return this.beforeFeedbackTurn(_ctx, runtimeConfig);
    }
    const telemetryEnabled = (
      await new WorkspacePrivacySettingsRepository(registryDb(this.env)).get(
        runtimeConfig.workspaceId,
      )
    ).telemetryEnabled;
    this.currentTurnTelemetryEnabled = telemetryEnabled;
    this._cachedWorkspaceId = runtimeConfig.workspaceId;
    const startedAt = Date.now();
    this.currentTurnStartedAt = startedAt;
    this.currentTurnAttentionRequiredRecorded = false;
    await recordThreadLifecycleEvent({
      env: this.env,
      event: {
        type: "thread.started",
        threadId: this.name,
        workspaceId: runtimeConfig.workspaceId,
        startedAt,
      },
    }).catch((error) =>
      log.warn("think_thread.notification_start_failed", {
        threadId: this.name,
        error: String(error),
      }),
    );
    const referencedAttachmentIds = extractAttachmentIdsFromModelMessages(_ctx.messages);
    if (referencedAttachmentIds.length > 0) {
      await new AttachmentRepository(registryBinding(this.env)).markCommitted(
        referencedAttachmentIds,
        this.name,
      );
    }
    const phClient = telemetryEnabled ? await getPostHogClient(this.env) : null;
    const traceId = crypto.randomUUID();
    const model = await buildThreadModelForWorkspace(
      this.env,
      runtimeConfig.modelConfig,
      runtimeConfig.workspaceId,
    );
    this.currentTurnTrace = {
      workspaceId: runtimeConfig.workspaceId,
      provider: runtimeConfig.modelConfig.provider,
      model: runtimeConfig.modelConfig.model,
      traceId,
    };
    // Name an untitled thread alongside the turn rather than inside it: the title
    // lands while the first answer is still streaming, and it doesn't depend on
    // the model choosing to call a tool (which is what used to fail).
    if (!runtimeConfig.titleSet && this.autoNameEnabled()) {
      const naming = autoNameThread({
        env: this.env,
        threadId: this.name,
        workspaceId: runtimeConfig.workspaceId,
        model,
        // The RESOLVED config, not the thread_index snapshot: the snapshot can be
        // null or name a no-longer-supported provider, in which case the model
        // that actually runs is the agent's — and the ledger row would otherwise
        // be keyed "unknown/unknown", permanently unattributable.
        modelProvider: runtimeConfig.modelConfig.provider,
        modelName: runtimeConfig.modelConfig.model,
        firstUserText: firstUserText(_ctx.messages),
      }).catch((error) =>
        log.warn("think_thread.auto_name_failed", {
          threadId: this.name,
          error: String(error),
        }),
      );
      this._autoNameForTest = naming;
      this.ctx.waitUntil(naming);
    }
    // NOTE: showReasoning is deliberately NOT consulted here — it decides only
    // whether the thinking text is displayed. Effort decides whether the model
    // thinks at all, which is what this call expresses.
    //
    // The profile is resolved per turn rather than snapshotted on the thread:
    // it describes the MODEL, so a cached copy going stale on a thread would
    // outlive the fact it recorded. Null (catalog unavailable or model unknown)
    // falls back to the thread's recorded capability.
    const reasoningProfile = await resolveModelReasoningProfile(
      this.env,
      runtimeConfig.modelConfig.provider,
      runtimeConfig.modelConfig.model,
      { ctx: this.ctx },
    ).catch((error: unknown) => {
      log.warn("think_thread.reasoning_profile_failed", {
        threadId: this.name,
        error: String(error),
      });
      return null;
    });
    const providerOptions = buildReasoningProviderOptions(runtimeConfig.modelConfig.provider, {
      effort: runtimeConfig.modelConfig.reasoningEffort,
      profile: reasoningProfile,
      modelSupportsReasoning: runtimeConfig.modelConfig.modelSupportsReasoning,
    });
    const turnSetupReminders: ModelMessage[] = [];
    // A one-shot wall clock on the thread's first turn (see thread-start-clock.ts).
    // Appended to the turn tail AND persisted: turn two reads it from history,
    // and the assistant reply that by then precedes it is what stops a second
    // stamp. Deliberately after the auto-name block above — the reminder is a
    // user-role message, and naming a thread from it would title every new
    // thread with a timestamp.
    if (isFirstTurn(_ctx.messages)) {
      const clock = buildThreadStartClockReminder(new Date());
      try {
        turnSetupReminders.push(...(await convertToModelMessages([clock])));
        await this.addMessages([clock]);
      } catch (error) {
        // A missing clock is not worth failing a turn over.
        log.warn("think_thread.clock_reminder_failed", {
          threadId: this.name,
          error: String(error),
        });
      }
    }
    this.currentTurnSetupReminders = turnSetupReminders;
    let hasWorkbench = false;
    try {
      // Joined into the same wave as resolveComputeService rather than added as
      // a separate sequential await: hasWorkbench is needed below for the
      // tool-step budget, and neither read depends on the other's result.
      const [turnSandbox, workbenchAssigned] = await Promise.all([
        resolveComputeService(this.sandboxHostDeps()),
        hasThreadWorkbench(this.env, this.name),
      ]);
      // Cache for the per-step auto-watch sweep (see beforeStep); avoids
      // re-running the expensive resolveComputeService on every step.
      this._turnSandboxService = turnSandbox?.service ?? null;
      hasWorkbench = workbenchAssigned;
      await turnSandbox?.service.cleanupExpiredRecoverableCompute();
    } finally {
      this.currentTurnSetupReminders = undefined;
    }
    const modelInputMessages =
      turnSetupReminders.length > 0 ? [..._ctx.messages, ...turnSetupReminders] : _ctx.messages;
    const preparedMessages = await this.prepareModelMessagesForThink(
      modelInputMessages,
      runtimeConfig.modelConfig,
    );
    const messages =
      runtimeConfig.modelConfig.provider === "openai-oauth"
        ? sanitizeOpenAIOAuthMessages(preparedMessages)
        : preparedMessages;

    // Resolve the turn's tool-step budget once and stash it: `beforeStep` is
    // synchronous, so it can't re-read the workbench and must wind down at the
    // SAME budget this turn started on.
    const maxSteps = this._testMaxToolSteps ?? resolveToolStepBudget(hasWorkbench);
    this.currentTurnMaxSteps = maxSteps;
    this.currentTurnHasWorkbench = hasWorkbench;

    // Config-aware: `{}` when sandbox execution is disabled/incomplete, which
    // keeps every `exec_*` tool out of both the turn tool set and the model's
    // allowlist (design spec: hide all exec tools when unconfigured).
    const sandboxTools = await createComputeTools(this.sandboxHostDeps());
    const sandboxToolNames = Object.keys(sandboxTools);

    // The agent's memories go in the prompt itself: recall must not depend on the
    // model deciding to search for something it doesn't know it has.
    const memoryIndex = await resolveMemoryIndex({
      env: this.env,
      workspaceId: runtimeConfig.workspaceId,
      agentId: runtimeConfig.agentId,
    }).catch((error) => {
      log.warn("think_thread.memory_index_failed", { threadId: this.name, error: String(error) });
      return undefined;
    });

    // Hoisted above composeSystemPrompt: the subagent policy must not describe
    // tools this turn will not expose, and the tool set itself is built below.
    const subagentsAvailable = runtimeConfig.subagentsEnabled && this.subagentSpawnEnabled();
    // Composed after sandboxTools: an empty tool set is the "sandbox unavailable"
    // signal, and the OCR policy is meaningless without exec_*.
    const system = composeSystemPrompt({
      systemPrompt: runtimeConfig.modelConfig.systemPrompt,
      sandboxAvailable: sandboxToolNames.length > 0,
      subagentsAvailable,
      ...(runtimeConfig.projectContext ? { projectContext: runtimeConfig.projectContext } : {}),
      ...(memoryIndex ? { memoryIndex } : {}),
    });
    // Stashed so `beforeStep`'s wind-down can append its directive to the same
    // prompt the turn started with.
    this.currentTurnWindDownSystem = system;
    const { createWebTools } = await import("./web-tools");
    const webTools = await createWebTools(this.webHostDeps());
    const webToolNames = Object.keys(webTools);
    const subagentTools = subagentsAvailable
      ? createSubagentTools({
          spawn: (input) => this.spawnSubagent(input),
          list: () => this.listSubagentRuns(),
          stop: (runId) => this.stopSubagentRun(runId),
        })
      : {};
    const subagentToolNames = Object.keys(subagentTools);
    // Backstop: `onStart` only kicks MCP warm-up in the background, so the first
    // turn must wait for it here before reading `this.mcp.getAITools()`. Usually
    // already settled by the time the user sends a message; memoized after.
    await this._ensureMcpServers();
    // `_ensureMcpServers` resolves when each server is CONNECTED, which is not
    // when its tools exist: discovery runs after the handshake, and the SDK
    // also restores connections by itself when a cell wakes from hibernation.
    // Reading `getAITools()` in between yields an incomplete tool set and the
    // SDK's own warning ("Reading tools from connection … in state
    // 'discovering'"), i.e. a turn that silently cannot see its MCP tools.
    // Observed on celld, where an evicted cell wakes on the message that starts
    // the turn; a warm cell mostly hides it.
    //
    // Bounded on purpose. This is the turn's hot path, and `waitForConnections`
    // defaults to waiting indefinitely — one unreachable MCP server would hang
    // every turn. It never rejects, so a server that is slow or dead simply
    // misses this turn and is picked up by the next one.
    await this.mcp.waitForConnections({ timeout: MCP_DISCOVERY_WAIT_MS });
    const mcpTurnConfig = await this.buildMcpPolicyTurnConfig(_ctx, runtimeConfig.workspaceId);

    // Merge sandbox tools into the turn tool set (Think merges TurnConfig.tools
    // with the assembled tools) and add their names to the model allowlist. Only
    // set `tools` when something is present so the no-MCP/no-sandbox path keeps
    // its prior shape (allowlist only, no tool override).
    // Cap each tool's output at persistence (a generous bound — only
    // pathological dumps are trimmed) so a single huge result can never land in
    // the protected head/tail and pin the compaction trigger.
    // Automaton runs are unattended: expose report_run_outcome so the model can
    // declare how the run ended (drives the turn-end lifecycle in onChatResponse).
    const outcomeTools =
      runtimeConfig.source === "automaton"
        ? createAutomatonOutcomeTools({ recordOutcome: (o) => this.recordAutomatonRunOutcome(o) })
        : {};
    const contextBudget = await this.currentContextBudget();
    // Stash the window and the compaction trigger for `onStepFinish`: the hot
    // path must not resolve them.
    this._currentContextWindow = contextBudget.contextWindow;
    this._currentCompactAfterTokens = contextBudget.compactAfterTokens;
    // Every context decision this turn derives from this one budget. Logged per
    // turn because the failure that hides best is a SILENT one: a model whose
    // window doesn't resolve falls back to the conservative default and the
    // thread quietly runs on a fraction of the context it is entitled to, with
    // nothing else in the logs to say so. Compaction events only fire when
    // compaction fires; this fires always.
    log.info("think_thread.turn_budget", {
      threadId: this.name,
      provider: runtimeConfig.modelConfig.provider,
      model: runtimeConfig.modelConfig.model,
      contextWindow: contextBudget.contextWindow,
      compactAfterTokens: contextBudget.compactAfterTokens,
      partHeadChars: contextBudget.partHeadChars,
      partTailChars: contextBudget.partTailChars,
      headMaxChars: contextBudget.headMaxChars,
      maxSteps,
      hasWorkbench,
    });
    // configureSession runs ONCE (in onStart), so the threshold it passed to
    // compactAfter is frozen — a mid-thread model switch would never update it.
    // compactAfter() only assigns fields, so re-arming here is safe.
    // `session` is only absent when beforeTurn is driven directly (the test
    // probe) — a real turn dereferences it before this hook. Warn rather than
    // skip quietly: if it ever went missing on a live turn, the thread would
    // run with a frozen threshold and the silence would hide it.
    if (!this.session) {
      log.warn("think_thread.compact_after_rearm_skipped", {
        threadId: this.name,
        reason: "no_session",
      });
    } else if (this._armedCompactAfter !== contextBudget.compactAfterTokens) {
      this.session.compactAfter(contextBudget.compactAfterTokens, {
        tokenCounter: async ({ messages: historyMessages, systemPrompt }) =>
          estimateTruncatedThreadTokens({
            messages: historyMessages,
            systemPrompt,
            budget: await this.currentContextBudget(),
          }),
      });
      this._armedCompactAfter = contextBudget.compactAfterTokens;
    }
    // Timing wraps the OUTSIDE of the output cap, so the recorded duration is
    // the whole call as the model experienced it — capping included. Wrapping
    // the merged set (MCP included) is deliberate: an `exec` and a Markdump MCP
    // call once went unresolved together with no way to tell which one stalled.
    const mergedTools = wrapToolsWithTiming(
      wrapToolsWithOutputCap(
        {
          ...mcpTurnConfig.tools,
          ...sandboxTools,
          ...webTools,
          ...subagentTools,
          ...outcomeTools,
        },
        contextBudget.maxToolOutputCapChars,
      ),
      this.toolCallTiming,
    );
    const activeTools = [
      ...(mcpTurnConfig.activeTools ?? []),
      ...sandboxToolNames,
      ...webToolNames,
      ...subagentToolNames,
      ...(runtimeConfig.source === "automaton" ? [AUTOMATON_OUTCOME_TOOL_NAME] : []),
    ];
    const systemForTurn =
      runtimeConfig.source === "automaton" ? `${system}\n\n${AUTOMATON_OUTCOME_CONTRACT}` : system;

    const turnConfig: TurnConfig = {
      model: instrumentModel(model, {
        client: phClient,
        workspaceId: runtimeConfig.workspaceId,
        threadId: this.name,
        traceId,
        captureContent: resolveCaptureContent(this.env),
        runtime: "think",
      }),
      system: systemForTurn,
      messages,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      experimental_transform: repairOrphanReasoningStream(),
      // Legacy parity: bound each turn's tool-call rounds and gracefully wind
      // down on the final step (see `beforeStep`). Think would otherwise cap at
      // its framework default of 10. A declared coding task raises the budget.
      maxSteps,
      ...(Object.keys(mergedTools).length > 0 ? { tools: mergedTools } : {}),
      activeTools,
    };
    this._lastBeforeTurnActiveToolsForTest = turnConfig.activeTools;
    return turnConfig;
  }

  private async beforeFeedbackTurn(
    _ctx: TurnContext,
    runtimeConfig: Awaited<ReturnType<ThinkThreadAgent["resolveRuntimeConfigForThink"]>>,
  ): Promise<TurnConfig> {
    const pendingUserMessageIds = trailingUserMessageIds(
      _ctx.messages as Array<{ id?: unknown; role?: unknown }>,
    );
    const fallbackPendingUserMessageIds =
      pendingUserMessageIds.length > 0
        ? pendingUserMessageIds
        : trailingUserMessageIds(this.messages);
    const uniquePendingUserMessageIds = new Set<string>();
    for (const messageId of fallbackPendingUserMessageIds) {
      if (uniquePendingUserMessageIds.has(messageId)) {
        throw new Error("feedback_duplicate_message_id");
      }
      uniquePendingUserMessageIds.add(messageId);
      if (await this.isFeedbackMessageDispatched(messageId)) {
        throw new Error("feedback_duplicate_message_id");
      }
      const decision = await reserveFeedbackSlot(this.ctx.storage, {
        kind: "model_turn",
        key: messageId,
        now: Date.now(),
      });
      if (!decision.ok) {
        throw new Error(`feedback_rate_limited:${decision.retryAfterSeconds}`);
      }
    }
    if (fallbackPendingUserMessageIds.length > 0) {
      await this.ensureFeedbackInterviewForUserMessage(fallbackPendingUserMessageIds[0]!);
      await this.markFeedbackMessagesDispatched(fallbackPendingUserMessageIds);
    }
    const referencedAttachmentIds = extractAttachmentIdsFromModelMessages(_ctx.messages);
    if (referencedAttachmentIds.length > 0) {
      await new AttachmentRepository(registryBinding(this.env)).markCommitted(
        referencedAttachmentIds,
        this.name,
      );
    }
    const currentInterviewMessages = await this.currentFeedbackInterviewMessages(
      _ctx.messages,
      _ctx.tools,
    );
    const messages = await this.prepareModelMessagesForThink(currentInterviewMessages, {
      modelInputModalities: ["text", "image"],
    });
    const traceId = crypto.randomUUID();
    this.currentTurnTrace = {
      workspaceId: runtimeConfig.workspaceId,
      provider: FEEDBACK_MODEL_PROVIDER,
      model: FEEDBACK_MODEL_ID,
      traceId,
    };
    this.currentTurnTelemetryEnabled = false;
    this._cachedWorkspaceId = runtimeConfig.workspaceId;
    this.currentTurnStartedAt = Date.now();
    this.currentTurnAttentionRequiredRecorded = false;
    this.currentTurnMaxSteps = 8;
    this.currentTurnHasWorkbench = false;
    this.currentTurnWindDownSystem = FEEDBACK_SYSTEM_PROMPT;
    this._turnSandboxService = null;
    this._currentContextWindow = undefined;
    this._currentCompactAfterTokens = undefined;

    const turnConfig: TurnConfig = {
      model: instrumentModel(buildFeedbackModel(this.env), {
        client: null,
        workspaceId: runtimeConfig.workspaceId,
        threadId: this.name,
        traceId,
        captureContent: false,
        runtime: "think",
      }),
      system: FEEDBACK_SYSTEM_PROMPT,
      messages,
      tools: createFeedbackTools({ prepare: (input) => this.prepareFeedbackDraft(input) }),
      activeTools: ["prepare_feedback_report"],
      maxSteps: 8,
    };
    this._lastBeforeTurnActiveToolsForTest = turnConfig.activeTools;
    return turnConfig;
  }

  /**
   * Final-step wind-down: when the tool-call budget is exhausted, strip tools
   * and tell the model to summarize instead of being silently cut off by the
   * `maxSteps` stop condition. Mirrors the legacy runtime's `prepareStep`.
   */
  // async override; SDK prepareStep wrapper awaits this
  async beforeStep(ctx: PrepareStepContext): Promise<StepConfig | void> {
    // Drain the durable injection buffer FIRST so this step's messages include
    // anything delivered since the last step (steering). Must happen here, not
    // in `beforeTurn` — draining there would persist via `addMessages` before
    // the turn's base messages are assembled, duplicating the message in both
    // the base and the appended injections.
    await this._drainInjectionsIntoTurn();
    // Auto-watch still-running processes at EACH step boundary, not just at
    // turn end (onChatResponse). A long-running process the model started and
    // left unwatched otherwise has no watcher until the turn ends — so the dock
    // can't show it and it can't complete/steer mid-turn. Sweeping here (still
    // "running" filter intact, so quick commands that already finished are not
    // watched) gives it a watcher at the next step. Reuses the turn's cached
    // service (cheap store sweep); gated + error-swallowed like the turn-end one.
    if (this.processMonitorEnabled() && this._turnSandboxService) {
      try {
        await this._turnSandboxService.autoWatchRunningProcesses({
          minAgeMs: MIN_STEP_WATCH_AGE_MS,
        });
      } catch (error) {
        log.warn("think_thread.step_auto_watch_failed", {
          threadId: this.name,
          error: String(error),
        });
      }
    }
    // Same budget the turn started on (stashed in `beforeTurn`); fall back to the
    // default only if a step somehow runs before `beforeTurn` stashed it.
    const maxSteps = this.currentTurnMaxSteps ?? this._testMaxToolSteps ?? MAX_TOOL_STEPS;
    const windDown =
      ctx.stepNumber !== undefined && isFinalToolStep(ctx.stepNumber, maxSteps)
        ? {
            activeTools: [] as string[],
            system: windDownSystemPrompt(this.currentTurnWindDownSystem ?? this.getSystemPrompt()),
          }
        : undefined;
    if (windDown) {
      log.info("think_thread.tool_budget_exhausted", {
        threadId: this.name,
        maxSteps,
        hasWorkbench: this.currentTurnHasWorkbench ?? false,
      });
    }
    const injected =
      this._activeTurnInjections.length > 0
        ? {
            messages: assembleStepMessages(
              (ctx as unknown as { messages: ModelMessage[] }).messages,
              this._activeTurnInjections,
            ),
          }
        : undefined;
    if (windDown && injected) return { ...windDown, ...injected };
    return windDown ?? injected;
  }

  /**
   * Drain the durable injection buffer into the RUNNING turn: persist via
   * `addMessages` (durable, renders a card, idempotent by id) and stash the
   * converted messages so `beforeStep` can append them to this step's input.
   *
   * Peek → persist → delete, in that order: a crash between peek and the
   * `addMessages` commit leaves the rows in the buffer for the next drain to
   * retry (harmless — `addMessages` is idempotent by id). Deleting BEFORE
   * persisting would permanently lose the message on a crash.
   */
  private async _drainInjectionsIntoTurn(): Promise<void> {
    const drained = this.injectionBuffer().peekAll();
    if (drained.length === 0) return;
    const messages = drained.map((d) => d.message);
    await this.addMessages(messages); // DURABLE: renders card + future turns; idempotent by id
    this.injectionBuffer().deleteDrained(drained.map((d) => d.seq)); // delete AFTER persist commits
    this._activeTurnInjections.push(...(await convertToModelMessages(messages)));
    // NOTE: we deliberately do NOT broadcast the injected message mid-turn.
    // `addMessages` suppresses its own broadcast inside the inference loop, so
    // the card syncs at turn end. Forcing a mid-turn broadcast is possible but
    // mis-orders: the client pins the single streaming assistant message last,
    // so a separately-added card can only render ABOVE the live stream, never
    // "in the middle" of it. The mid-turn signal is carried by the dock chip
    // (per-step auto-watch) and the model's live reaction; the detailed card
    // lands at turn end. A true in-stream card would need an inline data part.
  }

  /**
   * Think supplies beforeTurn with already-converted ModelMessages, so managed
   * attachment URLs need to be rewritten here instead of at the UIMessage layer.
   */
  private async prepareModelMessagesForThink(
    messages: ModelMessage[],
    cfg: { inputModalities?: string[]; modelInputModalities?: string[] },
  ): Promise<ModelMessage[]> {
    const repo = new AttachmentRepository(registryBinding(this.env));
    return prepareModelMessagesForModel(messages, {
      inputModalities: cfg.modelInputModalities ?? cfg.inputModalities ?? ["text"],
      resolveAttachment: async (id) => {
        const row = await repo.getByIdInThread(id, this.name);
        return row ? { r2Key: row.r2Key, mimeType: row.mimeType, filename: row.filename } : null;
      },
      presign: (r2Key) =>
        presignGet(presignDepsFromEnv(this.env), r2Key, {
          anchorMs: bucketedAnchorMs(Date.now(), PRESIGN_WINDOW_MS),
          expiresInSeconds: PRESIGN_EXPIRES_SECONDS,
        }),
      ...this.attachmentExtractor(repo),
    });
  }

  /**
   * Two gates, either of which disables the feature: the ATTACHMENT_EXTRACTION
   * var and the AI binding. Without an extractor, prepare falls back to the
   * getAttachmentUrl stub exactly as it did before the feature existed.
   */
  private attachmentExtractor(
    repo: AttachmentRepository,
  ): { extract: (id: string) => Promise<ExtractionResult | null> } | null {
    if (!isExtractionEnabled(this.env.ATTACHMENT_EXTRACTION)) return null;
    const ai = this.env.AI as Ai | undefined;
    if (!ai) return null;

    const threadId = this.name;
    const store: ExtractionStore = {
      load: async (id) => {
        const row = await repo.getByIdInThread(id, threadId);
        return row
          ? {
              id: row.id,
              mimeType: row.mimeType,
              filename: row.filename,
              r2Key: row.r2Key,
              byteSize: row.byteSize,
              extractedText: row.extractedText,
              extractedSource: row.extractedSource,
              extractedError: row.extractedError,
              extractedAttempts: row.extractedAttempts,
            }
          : null;
      },
      beginAttempt: (id) => repo.beginExtractionAttempt(id, threadId),
      saveSuccess: (id, text, source) => repo.saveExtraction(id, threadId, text, source),
      saveFailure: (id, error) => repo.recordExtractionFailure(id, threadId, error),
    };

    return {
      extract: createAttachmentExtractor({
        ai: ai as unknown as WorkersAi,
        bucket: attachmentsBucket(this.env),
        store,
      }),
    };
  }

  private async buildMcpPolicyTurnConfig(
    ctx: TurnContext,
    workspaceId: string,
  ): Promise<Pick<TurnConfig, "tools" | "activeTools">> {
    const rawTools = this._testToolOverride ?? this.mcp.getAITools();
    const rawToolNames = Object.keys(rawTools);
    // No MCP tools → skip the D1 policy lookup, but still emit an allowlist so
    // the built-in workspace file tools stay hidden from the model.
    if (rawToolNames.length === 0) {
      return { activeTools: this.activeToolNames(Object.keys(ctx.tools), new Set()) };
    }

    const policyMap = this._testPolicyMap ?? (await getMcpToolPolicyMap(this.env, workspaceId));
    const policyFor = (name: string) => {
      const toolPolicy = policyMap[name];
      return toolPolicy !== undefined ? decideToolPolicy({ toolPolicy }) : decideToolPolicy({});
    };
    const denied = new Set(rawToolNames.filter((name) => policyFor(name) === "deny"));
    const wrapped = wrapToolsWithPolicy(rawTools, policyFor);

    return {
      tools: wrapped,
      activeTools: this.activeToolNames(Object.keys({ ...ctx.tools, ...wrapped }), denied),
    };
  }

  /** Turn the merged tool set into the model's allowlist: drop denied MCP tools and built-in workspace tools. */
  private activeToolNames(mergedNames: string[], denied: Set<string>): string[] {
    return mergedNames.filter((name) => !denied.has(name) && !WORKSPACE_TOOL_NAMES.has(name));
  }

  private scheduleSearchProjection(): void {
    const ctx = (this as unknown as { ctx?: { waitUntil?: (promise: Promise<unknown>) => void } })
      .ctx;
    const waitUntil = ctx?.waitUntil?.bind(ctx);
    // Gate on the registry being reachable, not on the Cloudflare binding:
    // `env.REGISTRY_DB` is absent on celld, where the registry lives in a
    // Durable Object, and testing it here silently disabled projection there.
    if (!waitUntil || !hasRegistry(this.env ?? {})) return;

    scheduleLocalThreadSearchProjection({
      env: this.env,
      threadId: this.name,
      waitUntil: (promise) =>
        waitUntil(
          promise.catch((error) =>
            log.warn("think_thread.search_projection_failed", {
              threadId: this.name,
              error: String(error),
            }),
          ),
        ),
      source: async () => this.localThreadSearchProjectionSource(),
    });
  }

  private localThreadSearchProjectionSource(): ActiveTranscriptRpc {
    return {
      readThreadProsePage: (input) => this.readThreadProsePage(input),
      grepThreadProse: (input) => this.grepThreadProse(input),
      listThreadSearchDigests: (input) => this.listThreadSearchDigests(input),
      getThreadSearchDocuments: (messageIds) => this.getThreadSearchDocuments(messageIds),
    };
  }

  async onChatResponse(result?: ChatResponseResult): Promise<void> {
    // Drain the turn's usage BEFORE dropping the pinned config: attribution
    // reads it. Fires on every settle path Think routes here — `completed`,
    // `aborted` (a cancelled tool loop has already SPENT its tokens) and
    // `error` (when an assistant part was persisted).
    await this.flushTurnUsage();
    const cancelled = result?.status === "aborted";
    // The workspace decision is pinned for this turn. Keep it long enough for
    // the turn-end admission check below: dropping the pin first would fall
    // back to the deployment flag and could attach a watcher after an admin
    // disabled background work for this workspace.
    const monitor = this.processMonitorEnabled();
    // The turn is over: drop the pinned config so the next turn re-reads it.
    this._turnRuntimeConfig = null;
    // Clear the turn's budget pins with it: a later turn that dies before
    // `beforeTurn` re-pins them must not stamp the gauge with THIS turn's window.
    this._currentContextWindow = undefined;
    this._currentCompactAfterTokens = undefined;
    // A CANCELLED turn stops the sandbox too. Aborting the model loop only stops
    // the assistant talking; whatever it launched keeps running in the container.
    // So on cancel we kill the thread's running processes instead of watching
    // them — auto-watching here would re-attach a watcher to the very process the
    // user just asked to stop, and then report its completion later.
    //
    // Otherwise: turn-end backstop — attach a watcher to any still-running process
    // the model left unwatched, so nothing runs in the background without a
    // completion notification. Swallow errors — this must never fail a turn.
    // Note the stop path is NOT gated on processMonitorEnabled(): that flag is
    // about watcher support (SubAgent turns it off), and a cancelled subagent
    // must still stop the processes it launched.
    try {
      if (cancelled || monitor) {
        const resolved = await resolveComputeService(this.sandboxHostDeps(monitor));
        if (resolved) {
          if (cancelled) {
            const { stopped, failed } = await resolved.service.stopAllRunningProcesses();
            if (stopped.length || failed.length) {
              log.info("think_thread.cancel_stopped_processes", {
                threadId: this.name,
                stopped: stopped.length,
                failed: failed.length,
              });
            }
          } else if (monitor) {
            await resolved.service.autoWatchRunningProcesses();
          }
        }
      }
    } catch (error) {
      log.warn(cancelled ? "think_thread.cancel_stop_failed" : "think_thread.auto_watch_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
    // Turn-end flush: if injections arrived too late to be drained by a
    // beforeStep this turn (or arrived after the last step ran), kick a fresh
    // turn so they aren't stranded in the buffer until the next unrelated event.
    try {
      if (!this.injectionBuffer().isEmpty()) await this._kickInjectionTurn();
    } catch (error) {
      log.warn("think_thread.injection_flush_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
    // Turn-end backstop for a pending workbench switch: if the agent's turn
    // ended without it calling `confirm_workbench_switch` (ignored the
    // reminder, or the switch became unblocked only after the turn started),
    // retry the commit here so the switch does not wait on another user
    // message. A no-op when nothing is pending or another caller already won
    // the permit — see `commitWorkbenchSwitchIfPending`.
    try {
      await commitWorkbenchSwitchIfPending(this.workbenchSwitchCommitDeps());
    } catch (error) {
      log.warn("think_thread.workbench_switch_commit_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
    const startedAt = this.currentTurnStartedAt ?? Date.now();
    this.currentTurnStartedAt = null;
    // One read serves both the approval probe and the notification preview:
    // they ask different questions of the same just-finished assistant message.
    const finalMessages = await this.getMessages().catch((error) => {
      log.warn("think_thread.turn_end_history_read_failed", {
        threadId: this.name,
        error: String(error),
      });
      return [];
    });
    const hasPendingApproval = await this.turnHasPendingApproval(finalMessages).catch((error) => {
      log.warn("think_thread.notification_attention_probe_failed", {
        threadId: this.name,
        error: String(error),
      });
      return false;
    });
    const preview = extractPushPreview(finalMessages);
    const runtimeConfig = await this.resolveRuntimeConfigForThink().catch((error) => {
      log.warn("think_thread.outcome_runtime_config_failed", {
        threadId: this.name,
        error: String(error),
      });
      return null;
    });
    const declaredOutcome =
      runtimeConfig?.source === "automaton" ? await this.takeAutomatonRunOutcome() : null;
    const decision = decideAutomatonTurnEnd({ hasPendingApproval, declaredOutcome });
    const reason = declaredOutcome?.reason;

    if (decision === "attention_required") {
      await this.recordAttentionRequiredLifecycleEvent(reason, runtimeConfig?.workspaceId, preview);
    } else if (runtimeConfig) {
      await recordThreadLifecycleEvent({
        env: this.env,
        event:
          decision === "failed"
            ? {
                type: "thread.failed",
                threadId: this.name,
                workspaceId: runtimeConfig.workspaceId,
                startedAt,
                occurredAt: Date.now(),
                ...(reason ? { reason, preview: reason } : {}),
              }
            : {
                type: "thread.completed",
                threadId: this.name,
                workspaceId: runtimeConfig.workspaceId,
                startedAt,
                occurredAt: Date.now(),
                hadWatchedWork: false,
                ...(preview ? { preview } : {}),
              },
      }).catch((error) =>
        log.warn("think_thread.notification_complete_failed", {
          threadId: this.name,
          error: String(error),
        }),
      );
    }
    this.scheduleSearchProjection?.();
    const phClient = this.currentTurnTelemetryEnabled ? getCachedPostHogClient(this.env) : null;
    this.currentTurnTelemetryEnabled = undefined;
    if (phClient) await phClient.flush().catch(() => {});
  }

  onChatError(error: unknown, _ctx?: ChatErrorContext): unknown {
    const trace = this.currentTurnTrace;
    const phClient = this.currentTurnTelemetryEnabled ? getCachedPostHogClient(this.env) : null;
    // Think collapses turn failures into a generic client message; surface the
    // real provider error the same way the legacy runtime does. The truncated
    // response body is kept for diagnostics; headers are omitted (Set-Cookie).
    const api = APICallError.isInstance(error) ? error : undefined;
    log.error("think_thread.stream_error", {
      threadId: this.name,
      provider: trace?.provider,
      model: trace?.model,
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined,
      statusCode: api?.statusCode,
      url: api?.url,
      responseBody: api?.responseBody?.slice(0, 500),
      errorChain: serializeErrorChain(error),
    });
    if (this.currentTurnTelemetryEnabled && trace && phClient) {
      captureRunError(phClient, {
        workspaceId: trace.workspaceId,
        threadId: this.name,
        provider: trace.provider,
        model: trace.model,
        traceId: trace.traceId,
        runtime: "think",
        error,
      });
    }
    this.currentTurnTelemetryEnabled = undefined;
    // The turn died — but the steps it DID run already spent their tokens, and
    // Think skips `onChatResponse` entirely when no assistant part was persisted
    // (auth, 429, network), so this is the only place that spend can be banked.
    // `onChatError` is synchronous, hence `waitUntil`. Attribution re-resolves the
    // config (the pin below is cleared before the flush's first await lands) —
    // one extra read on a path that is already an error. Chained through
    // `_usageFlush`, so a turn that ALSO reaches `onChatResponse` cannot double-write.
    this.ctx.waitUntil(this.flushTurnUsage());
    // Turn-scoped config pin: `onChatResponse` clears it, but Think skips that
    // hook when a turn dies before any assistant part is persisted (auth, 429,
    // network). A leaked pin would let the NEXT turn's user-message append —
    // which runs before `beforeTurn` re-pins — resolve its budget from the model
    // the thread was on before the user switched away from it.
    this._turnRuntimeConfig = null;
    // Clear the turn's budget pins with it: a later turn that dies before
    // `beforeTurn` re-pins them must not stamp the gauge with THIS turn's window.
    this._currentContextWindow = undefined;
    this._currentCompactAfterTokens = undefined;
    const startedAt = this.currentTurnStartedAt;
    this.currentTurnStartedAt = null;
    this.currentTurnAttentionRequiredRecorded = false;
    // A tool that declared a run outcome and then errored this same turn must not
    // leave a stale outcome in storage for a later human-resumed turn to consume
    // (it would fire a spurious attention pin/push). Harmless no-op off automaton.
    this.ctx.waitUntil(this.ctx.storage.delete(AUTOMATON_OUTCOME_STORAGE_KEY).catch(() => {}));
    this.ctx.waitUntil(
      this.resolveRuntimeConfigForThink()
        .then((runtimeConfig) =>
          recordThreadLifecycleEvent({
            env: this.env,
            event: {
              type: "thread.failed",
              threadId: this.name,
              workspaceId: runtimeConfig.workspaceId,
              startedAt,
              occurredAt: Date.now(),
            },
          }),
        )
        .catch((notifyError) =>
          log.warn("think_thread.notification_failed_event_failed", {
            threadId: this.name,
            error: String(notifyError),
          }),
        ),
    );
    this.scheduleSearchProjection?.();
    if (phClient) this.ctx.waitUntil(phClient.flush().catch(() => {}));
    return chatErrorForClient(error);
  }

  /**
   * `messages` is optional so callers that already read the history can hand it
   * over rather than paying for a second read; the no-arg form is kept because
   * tests stub this method by name.
   */
  private async turnHasPendingApproval(messages?: readonly unknown[]): Promise<boolean> {
    const resolved = (messages ?? (await this.getMessages())) as Array<{
      parts?: Array<{ state?: string }>;
    }>;
    const lastMessage = resolved.at(-1);
    if (!lastMessage?.parts) {
      return false;
    }
    return lastMessage.parts.some((part) => part.state === "approval-requested");
  }

  private async recordAttentionRequiredLifecycleEvent(
    reason?: string,
    workspaceId?: string,
    preview?: string | null,
  ): Promise<void> {
    if (this.currentTurnAttentionRequiredRecorded) {
      return;
    }
    this.currentTurnAttentionRequiredRecorded = true;
    try {
      // Reuse the caller's already-resolved workspace when it has one; only fall
      // back to a fresh resolve (which also retries if the caller's resolve failed).
      const resolvedWorkspaceId =
        workspaceId ?? (await this.resolveRuntimeConfigForThink()).workspaceId;
      await recordThreadLifecycleEvent({
        env: this.env,
        event: {
          type: "thread.attention_required",
          threadId: this.name,
          workspaceId: resolvedWorkspaceId,
          occurredAt: Date.now(),
          ...(reason ? { reason } : {}),
          ...(preview ? { preview } : {}),
        },
      });
    } catch (error) {
      log.warn("think_thread.notification_attention_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
  }

  ping(): string {
    return "think:ok";
  }

  hasActiveTurn(): boolean {
    const activeRequestId = (this as unknown as { _activeRequestId?: string | null })
      ._activeRequestId;
    return activeRequestId !== null && activeRequestId !== undefined;
  }

  async compatibilityReport() {
    const skillSources = await this.getSkills();
    return {
      hasBeforeTurn: typeof this.beforeTurn === "function",
      hasConfigureSession: typeof this.configureSession === "function",
      hasGetSkills: typeof this.getSkills === "function",
      hasGetTools: typeof this.getTools === "function",
      hasSessionMemory: true,
      hasSkillsSource: skillSources.length > 0,
      workspaceBash: this.workspaceBash,
    };
  }

  async resolveRuntimeConfigForThink() {
    // Cached per DO wake (see `_runtimeConfig`); `beforeTurn` invalidates so each
    // turn reads fresh. Collapses the cold-open D1 query storm into one.
    return this._runtimeConfig.get();
  }

  private async assertThreadWritable(): Promise<void> {
    let config: Awaited<ReturnType<ThinkThreadAgent["resolveRuntimeConfigForThink"]>>;
    try {
      config = await this.resolveRuntimeConfigForThink();
    } catch (error) {
      if (String(error).includes("think_thread_not_registered:")) {
        return;
      }
      throw error;
    }
    if (config.archivedAt != null) {
      throw new Error("thread_archived_read_only");
    }
  }

  /**
   * Overridden by {@link SubAgent} to attach the shared-compute tools to the
   * parent's already-provisioned compute environment instead of provisioning a
   * new one. `undefined` (the default) means "no attached runtime" — the base
   * runtime resolves/creates its own environment as usual.
   */
  protected attachedRuntimeForThisAgent(): BackendReference | undefined {
    return undefined;
  }

  /** Whether process watchers + the turn-end auto-watch backstop are available.
   *  Overridden to false in SubAgent to avoid subagent-owned watchers. */
  protected processMonitorEnabled(): boolean {
    return this._turnRuntimeConfig?.backgroundExecEnabled ?? backgroundWorkEnabled(this.env);
  }

  /** Whether an untitled thread gets named from its first message. Overridden to
   *  false in SubAgent: a subagent thread is titled by the tool that spawned it,
   *  and its "first message" is a task brief nobody reads in a thread list. */
  protected autoNameEnabled(): boolean {
    return true;
  }

  /**
   * Hook for a rehydrated facet to prime whatever context it needs BEFORE
   * `attachedRuntimeForThisAgent()`/`sandboxHostDeps()` are consulted
   * outside a normal turn (e.g. the alarm-driven `runSandboxEviction`, which
   * never goes through `beforeTurn`). No-op by default; overridden in
   * {@link SubAgent} to pull+cache the parent's shared runtime reference (see H2).
   */
  protected async primeAttachedContext(): Promise<void> {}

  /**
   * Optional extra system-context block, appended before the prompt-cache
   * boundary in {@link configureSession} so it caches with the system prompt.
   * Null on a top-level thread; {@link SubAgent} returns a role notice telling
   * the model it is a subagent with a reduced tool set.
   */
  protected sessionRoleContext(): { name: string; text: string } | null {
    return null;
  }

  /** Whether this agent may spawn subagents. Parent: yes; SubAgent: no (depth-1). */
  protected subagentSpawnEnabled(): boolean {
    return this._turnRuntimeConfig?.subagentsEnabled ?? backgroundWorkEnabled(this.env);
  }

  /**
   * Admission outside a model turn must read the workspace's current setting,
   * rather than reuse the per-wake runtime cache. Within a turn the decision is
   * deliberately pinned so every tool has the same capability surface.
   */
  private async backgroundCapabilities(): Promise<BackgroundCapabilities> {
    if (this._turnRuntimeConfig) {
      return {
        backgroundExec: this._turnRuntimeConfig.backgroundExecEnabled,
        subagents: this._turnRuntimeConfig.subagentsEnabled,
      };
    }
    this._runtimeConfig.invalidate();
    try {
      const config = await this.resolveRuntimeConfigForThink();
      return { backgroundExec: config.backgroundExecEnabled, subagents: config.subagentsEnabled };
    } catch {
      // Fail closed. This `catch` is what the removed deployment-flag
      // short-circuit used to provide for free: an unregistered thread cannot
      // resolve a runtime config (`thread_agent_not_registered`), and admission
      // must answer `false` rather than propagate. A throw here would be worse
      // than a wrong answer — inside a DO RPC it also fires an unhandled
      // rejection, which fails the suite even when assertions pass.
      return { backgroundExec: false, subagents: false };
    }
  }

  /**
   * May this thread background a shell command — detach it, watch it, and accept
   * its pushed completion?
   *
   * The gate for every EXEC-side surface. Notably `reportProcessCompletion`
   * gates on this rather than on {@link backgroundWorkAdmitted}: a workspace with
   * exec off must not accept a process completion callback, even if it has
   * subagents on.
   */
  private async backgroundExecAdmitted(): Promise<boolean> {
    return (await this.backgroundCapabilities()).backgroundExec;
  }

  /** May this thread spawn subagents? */
  private async subagentsAdmitted(): Promise<boolean> {
    return (await this.backgroundCapabilities()).subagents;
  }

  /**
   * Is ANY background work available? The gate for the kind-agnostic surfaces —
   * the ledger read the dock polls, cancel, and clear-finished. They handle rows
   * of both kinds and need no per-kind branch: with exec off, no process rows
   * exist to return.
   */
  private async backgroundWorkAdmitted(): Promise<boolean> {
    return anyBackgroundWorkEnabled(await this.backgroundCapabilities());
  }

  /**
   * WHY THERE IS NO `if (!backgroundWorkEnabled(this.env)) return false` in
   * {@link backgroundCapabilities}.
   *
   * There used to be, as an "outer fail-closed gate" ahead of the workspace
   * read. It made the deployment flag override a workspace OPT-IN, which is
   * backwards: `resolveWorkspaceBackgroundWork` treats an explicit workspace
   * `true` as authoritative precisely so a single workspace can be enabled
   * against an off deployment — the only way to pilot this feature.
   *
   * The two resolutions then disagreed. In-turn code
   * (`processMonitorEnabled`/`subagentSpawnEnabled`) reads
   * the pinned turn config, which honours the override, so
   * work was backgrounded and watched normally. Out-of-turn callers came through
   * here and were refused. Observed live on 2026-08-12 with the deployment flag
   * off and one workspace opted in: `listBackgroundWork` returned `[]` so the
   * dock never rendered at all, and `reportProcessCompletion` rejected every
   * pushed callback as `background_work_disabled` — so completion silently came
   * from the 60s backstop poll instead, which made the push path look like it
   * worked when it had never run.
   *
   * The cost of removing it is one uncached workspace resolution per
   * out-of-turn admission check on deployments where the feature is off. That is
   * the price of the override meaning what it says; do not reinstate the
   * short-circuit to save it.
   */

  /**
   * Serialize a lease mutation so concurrent spawns can't lose an update: the
   * AI SDK executes multiple tool calls in one step concurrently, and
   * `spawn_subagent`'s description explicitly invites spawning several at once.
   * `blockConcurrencyWhile` queues concurrent callbacks strictly one-at-a-time.
   *
   * Safe here in a way it was NOT for sandbox provisioning (which used to use it
   * and deliberately no longer does — see `ThreadComputeService.ensureRuntime`):
   * this callback touches storage only. Nothing inside it calls a backend, so it
   * cannot hold the gate on a network round-trip.
   *
   * The lease is now a ledger row (`kind: "subagent"`), so the mutation is a
   * single atomic SQL statement rather than the read-modify-write over one
   * storage key this originally protected. Kept anyway: it is the ordering
   * guarantee that a spawn's row exists before anything can observe the run,
   * and it costs nothing.
   */
  private serializeLeaseMutation<T>(fn: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(fn);
  }

  /**
   * Ensure the shared machine exists, register the run in the work ledger,
   * dispatch the child DETACHED (notify-on-finish), and roll the row back if
   * dispatch is rejected (e.g. maxConcurrentAgentTools exceeded, which returns
   * status:"error"). Never throws: every failure path (including a thrown
   * `getSubagentContext`/register/dispatch) resolves to `{ error }` so the
   * tool's `execute` (which has no try/catch) always gets a structured result.
   *
   * The ledger row IS the lease and IS the run timing — both views derive from
   * it (see `openSubagentRunIds` / `listSubagentRuns`), so there is nothing
   * left to drift. It also puts the run under the reaper: a child on a sandbox
   * that gets reset, or one that goes silent for `SUBAGENT_STALE_AFTER_MS`,
   * now gets a terminal instead of hanging the parent forever.
   *
   * Rollback DELETES the row rather than terminalizing it: the dispatch never
   * happened, so no terminal is truthful and the model was never told a run
   * started (same reasoning as `exec_unwatch`'s `deleteRow`).
   *
   * `SubAgent` is imported lazily to avoid a static import cycle:
   * `subagent.ts` imports `ThinkThreadAgent` from this module.
   */
  private async spawnSubagent(input: {
    task: string;
    label?: string;
    toolCallId?: string;
  }): Promise<{ runId: string } | { error: string }> {
    if (!(await this.subagentsAdmitted())) {
      return { error: "background_work_disabled" };
    }
    const runId = `sub_${crypto.randomUUID()}`;
    let registered = false;
    try {
      // Provision the machine now so the child attaches to a live id.
      await this.getSubagentContext();
      // Resolve ONCE, AFTER provisioning: the generation stamp and the alarm
      // fold below both need this service, and resolving twice costs a second
      // round of D1 reads. Mirrors `getCurrentGeneration`'s contract — an
      // unresolvable service degrades to "unknown", never to a throw.
      let resolved: Awaited<ReturnType<typeof resolveComputeService>>;
      try {
        resolved = await resolveComputeService(this.sandboxHostDeps());
      } catch {
        resolved = null;
      }
      // The generation must come from AFTER provisioning, so the row is stamped
      // with the machine the child actually attaches to — a row registered
      // against an older nonce would fault itself on the very next sweep.
      //
      // PROBE first, then read. The store's nonce is only questioned by the
      // poll-failure probe, so a wipe with no watcher armed leaves it advertising
      // a stale nonce indefinitely; a child stamped with that would false-fault
      // `sandbox_reset` when a later probe restores. This is a spawn — a model
      // turn already calling the backend — never the sweep. Non-throwing by
      // construction, and no row exists yet (`registered` is still false), so the
      // outer catch would degrade the spawn to `{ error }`, never roll anything back.
      await resolved?.service.refreshGeneration();
      const generation = resolved?.service.getGeneration() ?? UNKNOWN_GENERATION;
      const now = Date.now();
      await this.serializeLeaseMutation(async () =>
        this.workLedger.register({
          id: runId,
          kind: "subagent",
          startedAt: now,
          lastAliveAt: now,
          staleAfterMs: SUBAGENT_STALE_AFTER_MS,
          deadlineAt: now + SUBAGENT_DEADLINE_MS,
          generation,
          terminal: null,
          deliveredAt: null,
        }),
      );
      registered = true;
      // Arm through the compute service's own fold, exactly as `execStart` /
      // `execWatch` do right after registering their rows. Without it the alarm
      // stays at the idle-release time and this run's 3-minute stale horizon is
      // not armed until some later tick happens to re-fold — a wedged child
      // would go unclassified for up to `idleTimeoutMs`. Guarded: an arm failure
      // costs a late first sweep (the alarm callback's fallback re-arm still
      // covers it), never the spawn. A row later rolled back below leaves at
      // most one spurious wake, which the next tick re-folds away.
      try {
        await resolved?.service.refreshWorkAlarm();
      } catch (error) {
        log.warn("think_thread.subagent_arm_failed", {
          threadId: this.name,
          runId,
          error: String(error),
        });
      }
      const { SubAgent } = await import("./subagent");
      const result = await this.runAgentTool(SubAgent, {
        input: input.task,
        runId,
        display: { name: deriveRunLabel(input.task, input.label) },
        // Bind the run to the spawning tool call so useAgentToolEvents places it
        // in runsByToolCallId (the web run card correlates on this). Without it
        // the detached run is "unbound" and no card renders.
        ...(input.toolCallId ? { parentToolCallId: input.toolCallId } : {}),
        detached: SUBAGENT_DETACHED,
      });
      if (result.status === "error") {
        await this.serializeLeaseMutation(async () => this.workLedger.deleteRow(runId));
        return { error: result.error ?? "subagent_dispatch_failed" };
      }
      return { runId };
    } catch (error) {
      if (registered) {
        await this.serializeLeaseMutation(async () => this.workLedger.deleteRow(runId));
      }
      return { error: String(error) };
    }
  }

  /**
   * Facet -> parent liveness stamp for a running subagent. The ledger lives on
   * the PARENT's storage (a facet has its own, and rows there would be
   * invisible to the parent's reaper), so the child reaches back through
   * `parentAgent()` — the same path `getSubagentContext` already uses — and
   * this is the receiving end. The child's facet NAME is the run id.
   *
   * Only infrastructure calls this, never the model: liveness means "this run
   * is in flight", not "the model said it was making progress". That
   * distinction is the whole reason the SDK's `noProgressBudgetMs` timer is
   * disabled (see subagent-config.ts) — it faulted healthy long silent work.
   *
   * `stampAlive` is a no-op for an unknown or already-terminal row, so a late
   * or duplicate stamp can never resurrect a closed run.
   *
   * `progress` rides along on this same call rather than getting an RPC of its
   * own — the child already stamps liveness every turn and on a timer, so this
   * is free. It is the ONLY way the parent learns a child's progress: the SDK's
   * `reportProgress` persists to the CHILD's storage, so the parent's
   * `inspectAgentToolRun` can never see it (see `WorkRow.progress`). Optional
   * so an older child facet mid-deploy still stamps liveness correctly.
   */
  async stampSubagentAlive(runId: string, progress?: WorkProgress): Promise<void> {
    const at = Date.now();
    this.workLedger.stampAlive(runId, at);
    // Trusted like the liveness stamp itself — this comes from the child's own
    // turn bookkeeping (`beforeTurn`'s step counter), never from model output.
    if (progress) this.workLedger.stampProgress(runId, progress);
  }

  /**
   * Guaranteed terminal edge for every agent-tool run (success/error/aborted/
   * interrupted, awaited or detached). Closes the run's ledger row, which is
   * what releases the shared-machine eviction hold and stamps the run's
   * finishedAt — both are derived from the row now.
   *
   * This closes the row through the STORE (`workLedger.terminalize`), NOT
   * through the `terminalizeWork` funnel, and the asymmetry is deliberate — it
   * mirrors what the compute layer does for a cleanly exited process (see
   * `WorkLedgerSink.terminalize`). The funnel exists to tell the model about a
   * terminal it has not already been told about; a run reaching this hook has
   * ALREADY been reported to the model by the `_deliverDetachedTerminal`
   * override, with its real summary. Funnelling it would inject a second,
   * emptier "Subagent X exited." on top of every completion, and would re-enter
   * `cancelAgentTool` on a run the SDK is already terminalizing.
   *
   * The reaper is the funnel's caller, and the exactly-once gate keeps the two
   * from colliding: whichever closes the row first wins, and the loser's
   * `terminalize` returns false.
   *
   * A soft interrupt (the SDK's detached-run contract fires this hook when the
   * parent stops waiting, e.g. `noProgressBudgetMs`) reports
   * `{ status: "interrupted", childStillRunning: true }` while the child facet
   * is STILL RUNNING on the shared Daytona machine; the real terminal
   * (`completed`/`error`/`aborted`, or an `interrupted` from the hard
   * `maxBudgetMs` teardown) fires this hook again later with
   * `childStillRunning` falsy. Closing the row on the soft-interrupt call would
   * drop the eviction-defer hold while the child is live, letting the parent
   * evict (and DELETE) the shared machine out from under a running child. Keep
   * the row open in that case; the later hard terminal closes it (the row stays
   * stamped alive by the child meanwhile, and `maxBudgetMs` — mirrored as the
   * row's own `deadlineAt` — is the guaranteed backstop, so this can never
   * leak).
   */
  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult,
  ): Promise<void> {
    if (result.status === "interrupted" && result.childStillRunning) return;
    // An `aborted` run was deliberately cancelled — it did not exit. Now that
    // terminals are what the model is TOLD, calling that `exited` is the exact
    // lie the taxonomy forbids: it would license reading a partial result as
    // the finished one. The raw SDK status rides along in `detail` either way.
    const stopped = result.status === "aborted";
    // WHO asked. `cancelSubagentRun` is the only path that can know, and it
    // recorded the answer on its way into the SDK; an abort with no pending
    // entry is one nobody here asked for (the SDK's own budget), which is
    // exactly what `"system"` means to the model. Consumed here so the map
    // cannot grow with the thread.
    const actor: WorkStopActor | undefined = stopped ? this.takeStopActor(run.runId) : undefined;
    await this.serializeLeaseMutation(async () => {
      const at = Date.now();
      const closed = this.workLedger.terminalize(run.runId, {
        outcome: stopped ? "stopped" : "exited",
        reason: stopped ? "process_stopped" : "process_exit",
        at,
        detail: result.status,
        ...(actor ? { actor } : {}),
      });
      // Declare that the sweep owes this row nothing: the `_deliverDetachedTerminal`
      // override reports this run's terminal (with its real summary), so a retry
      // would stack a second, emptier "Subagent X exited." on top of every
      // completion. Stamping is how that intent is stated — the sweep no longer
      // infers it from the terminal's reason.
      //
      // ONLY when this call actually closed the row. A false return means the
      // REAPER closed it first, and its delivery may still be genuinely owed
      // (that is the whole point of the split); stamping someone else's open
      // obligation would swallow it forever.
      if (closed) this.workLedger.markDelivered(run.runId, at);
      return closed;
    });
  }

  /**
   * Has the REAPER already reported this run's terminal to the model?
   *
   * Public only because the `_deliverDetachedTerminal` override is installed on
   * the prototype as a module-level function (see its doc) and so cannot reach a
   * private member. Not part of any RPC surface.
   *
   * The reaper's own teardown re-enters the SDK: `terminalizeWork` delivers its
   * fault, then calls `cancelSubagentRun` -> `cancelAgentTool`, which fires
   * `_deliverDetachedTerminal(runId, "finish", { status: "aborted" })`. That is a
   * SECOND injection under a different dedupe key (`:finish` vs the terminal's
   * `:<outcome>`), so the buffer cannot collapse the pair and the model reads a
   * fault followed by a redundant "cancelled" card.
   *
   * Keying on the reaper's REASONS rather than on "is the row terminal" is what
   * keeps the normal path intact — that path legitimately depends on the
   * `finish` injection to carry the run's summary. It is correct in either
   * interleaving: a clean completion closes the row as `process_exit` (or a
   * user cancel as `process_stopped`), neither of which is a reaper reason, and
   * a row not yet closed reads as `null`. Both fall through and report.
   */
  reaperAlreadyReported(runId: string): boolean {
    try {
      const terminal = this.workLedger.get(runId)?.terminal;
      return terminal ? REAPER_WORK_REASONS.has(terminal.reason) : false;
    } catch {
      // A read failure must cost a duplicate card, never a lost completion.
      return false;
    }
  }

  /**
   * Cancel a running subagent by run id. Callable over the already-authorized
   * client socket (same trust model as the other callables — the connection is
   * authorized upstream). Idempotent: `cancelAgentTool` is a no-op for an
   * unknown or already-terminal run id. The aborted terminal fires
   * {@link onAgentToolFinish}, releasing the shared-machine lease.
   */
  async cancelSubagentRun(runId: string, actor: WorkStopActor = "system"): Promise<void> {
    this.stopActors().set(runId, actor);
    // Bounded: a cancel whose `finish` never arrives (the run was already gone)
    // leaves its entry behind, and this map lives as long as the thread. The
    // cap is generous next to any realistic number of in-flight cancels, and
    // dropping the OLDEST is right — the newest cancel is the one whose
    // terminal is still coming.
    const actors = this.stopActors();
    while (actors.size > 64) {
      const oldest = actors.keys().next().value;
      if (oldest === undefined) break;
      actors.delete(oldest);
    }
    await this.cancelAgentTool(runId);
  }

  /**
   * Pending stop attributions, keyed by run id. Lazily created so the
   * duck-typed `this` the unit tests drive these methods over need not know
   * about the field (same style as the other prototype-driven methods).
   */
  private stopActors(): Map<string, WorkStopActor> {
    return (this.pendingStopActors ??= new Map<string, WorkStopActor>());
  }

  /** Reads and clears the pending attribution for a run. */
  private takeStopActor(runId: string): WorkStopActor {
    const actors = this.stopActors();
    const actor = actors.get(runId);
    actors.delete(runId);
    return actor ?? "system";
  }

  /**
   * The actor to report for a run's stop, for the completion the model reads.
   *
   * Reads the LEDGER, not the pending map: `onAgentToolFinish` consumes the
   * pending entry when it writes the terminal, and the completion is delivered
   * by a separate SDK callback whose ordering against that write is not ours to
   * choose. The row is the durable record either way — a redelivery after a
   * reconcile (or after the DO was evicted) still finds it there.
   *
   * Public only because `_deliverDetachedTerminal` is installed on the
   * prototype as a module-level function and so cannot reach a private member
   * (see that override's doc). Not part of any RPC surface. `undefined` for a
   * run that was not stopped, or one stopped before this was recorded — the
   * model is then told the status alone rather than a guessed actor.
   */
  stopActorFor(runId: string): WorkStopActor | undefined {
    try {
      const terminal = this.workLedger.get(runId)?.terminal;
      return terminal?.outcome === "stopped" ? terminal.actor : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `stop_subagent`: the MODEL cancelling a subagent it spawned. Distinct from
   * `cancelBackgroundWork` (the sheet's stop button, attributed to the user)
   * only in the attribution and in what it refuses — the model addresses runs
   * by id from its own tool results, so a stale or wrong id must come back as a
   * plain reason it can act on rather than a silent no-op. The ledger row is
   * the authority for "is this one of mine, and is it still running".
   */
  async stopSubagentRun(runId: string): Promise<{ ok: true } | { error: string }> {
    const row = this.workLedger.get(runId);
    if (!row) return { error: "unknown_run" };
    if (row.kind !== "subagent") return { error: "not_a_subagent" };
    if (row.terminal) return { error: "already_terminal" };
    await this.cancelSubagentRun(runId, "agent");
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // DEBUG-ONLY RPC (driven from the DEBUG_TOKEN-gated /api/debug routes so a
  // maintainer can create + drive a thread's sandbox/subagents without the UI).
  // These are plain stub-RPC methods (not client `callable`s); the gate is the
  // debug token on the route. Used to reproduce the R1 background-exec
  // output-capture bug in isolation.
  // ---------------------------------------------------------------------------

  /** Start a background command in this thread's own sandbox; returns its id. */
  async debugExecStart(command: string): Promise<{ processId: string; status: string }> {
    const admission = await this.backgroundExecAdmitted();
    if (!admission) throw new Error("background_work_disabled");
    const resolved = await resolveComputeService(this.sandboxHostDeps(admission));
    if (!resolved) throw new Error("sandbox_disabled");
    // Debug endpoint intentionally bypasses sync-first exec so diagnostics can
    // reproduce attached/background process behavior directly.
    const started = await resolved.service.execStart({ command });
    return { processId: started.processId, status: started.status };
  }

  /**
   * Prove the stop button actually terminates sandbox work, end to end.
   *
   * Starts a long-running process, kicks a REAL turn, then aborts it the same way
   * the UI's stop button does (`chat-request-cancel` -> the same AbortRegistry
   * controller `abortAllRequests` trips). Reports the process's status afterwards:
   * `running` means the turn was cancelled and the sandbox kept burning — the very
   * bug this exists to catch.
   */
  async debugCancelTurn(
    waitMs = 4000,
  ): Promise<{ processId: string; statusBefore: string; statusAfter: string; exitCode: unknown }> {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("sandbox_disabled");
    const started = await resolved.service.execStart({ command: "sleep 600" });
    const statusBefore = started.status;

    // Kick a real turn and do NOT await it — we need it in flight to cancel it.
    const turn = this.submitMessages([
      {
        id: `msg_${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "Count slowly from 1 to 200, one number per line." }],
      },
    ]).catch(() => undefined);

    await new Promise((r) => setTimeout(r, waitMs));
    this.abortAllRequests();
    await turn;
    // onChatResponse runs on the abort path; give it a moment to settle.
    await new Promise((r) => setTimeout(r, 3000));

    const after = await resolved.service.execStatus({ processId: started.processId });
    return {
      processId: started.processId,
      statusBefore,
      statusAfter: after.status,
      exitCode: after.exitCode ?? null,
    };
  }

  /**
   * Drive the REAL sync-first `exec()` — the path the model's exec tool takes,
   * including its foreground status-poll loop. `debugExecStart` deliberately
   * bypasses that loop, so only this can show whether exec is exposed to the
   * getProcess-at-exit wedge that broke run_skill_script.
   */
  async debugExec(
    command: string,
    uploads = 0,
  ): Promise<{ elapsedMs: number; uploadMs: number; result: unknown }> {
    const admission = await this.backgroundExecAdmitted();
    const resolved = await resolveComputeService(this.sandboxHostDeps(admission));
    if (!resolved) throw new Error("sandbox_disabled");
    // Optionally do file uploads FIRST, in this same invocation — the one thing
    // the skill-script runner did that exec never does. If exec only wedges with
    // uploads ahead of it, they are the trigger, not the exit poll.
    const uploadStart = Date.now();
    for (let i = 0; i < uploads; i++) {
      await resolved.service.execUploadFile({
        destinationPath: `/run/probe_${crypto.randomUUID()}/f${i}.txt`,
        bytes: new TextEncoder().encode(`probe ${i}\n`).buffer as ArrayBuffer,
        overwrite: true,
      });
    }
    const uploadMs = Date.now() - uploadStart;
    const start = Date.now();
    const result = await resolved.service.exec({ command });
    return { elapsedMs: Date.now() - start, uploadMs, result };
  }

  /**
   * Ask the PROVIDER for a process's status, bypassing the store. This is the
   * exact call the skill-script poll loop makes; `debugExecOutput` cannot stand
   * in for it, because its status comes from the store (which only advances via
   * a watcher). Use it to see what the backend actually reports over time.
   */
  async debugExecStatus(
    processId: string,
  ): Promise<{ status: string; exitCode: number | null; elapsedMs: number }> {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("sandbox_disabled");
    const start = Date.now();
    const fresh = await resolved.service.execStatus({ processId });
    return {
      status: fresh.status,
      exitCode: fresh.exitCode ?? null,
      elapsedMs: Date.now() - start,
    };
  }

  /** Read a process's captured output (refreshes from the provider first). */
  async debugExecOutput(
    processId: string,
  ): Promise<{ status: string; exitCode: number | null; stdout: string; stderr: string }> {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("sandbox_disabled");
    const out = await resolved.service.execOutput({ processId, stream: "stdout" });
    const err = await resolved.service.execOutput({ processId, stream: "stderr" });
    return {
      status: out.status,
      exitCode: out.exitCode ?? null,
      stdout: out.text,
      stderr: err.text,
    };
  }

  /**
   * Drive the REAL ComputeSkillScriptRunner end-to-end against this thread's
   * live sandbox — no model turn, no skill registry. This is the path the unit
   * fakes cannot vouch for: the request carries the script in `resources` (the
   * real SDK shape that broke uploads, PR #22), and the script sleeps so it
   * reliably outlives execStart, forcing the completion poll that used to spin
   * on store-only status forever (PR #23). Returns the raw SkillScriptResult
   * plus wall-clock duration: a healthy run is ok:true in roughly
   * sleepSeconds + a few poll intervals.
   */
  async debugSkillScript(sleepSeconds = 5): Promise<{ durationMs: number; result: unknown }> {
    const sleep = Math.min(Math.max(Math.trunc(sleepSeconds), 0), 60);
    const runner = new ComputeSkillScriptRunner({
      getService: async () => {
        const resolved = await resolveComputeService(this.sandboxHostDeps());
        return resolved ? resolved.service : null;
      },
      allowlist: null,
      threadId: this.name,
    });
    const source = [
      "import json, os, time",
      `time.sleep(${sleep})`,
      'with open(os.environ["SKILL_INPUT"]) as f:',
      "    inp = json.load(f)",
      'with open(os.environ["SKILL_OUTPUT_JSON"], "w") as f:',
      '    json.dump({"ok": True, "echo": inp}, f)',
      'print("SMOKE_OK")',
    ].join("\n");
    const request: SkillScriptRequest = {
      skill: { name: "debug-skill-script", description: "debug probe", body: "debug probe" },
      path: "scripts/run.py",
      source,
      input: { probe: "debug", sleepSeconds: sleep },
      resources: [{ path: "scripts/run.py", kind: "script", content: source }],
    };
    const start = Date.now();
    const result = await runner.run(request);
    return { durationMs: Date.now() - start, result };
  }

  /**
   * Exercise the native file tools against the live compute backend.
   *
   * Unit tests run against `FakeComputeBackend`, which cannot prove two contracts
   * the real provider must honor: that `inspectPath` reports `type: "symlink"`
   * (the whole path-escape guard rests on it), and that `movePath(overwrite)`
   * replaces an existing destination (every in-place `apply_patch` update). Each
   * step reports its own outcome instead of throwing, so one failure does not
   * hide the rest. Writes only under `/workspace/.nadi-debug-file-tools/`.
   */
  async debugFileTools(): Promise<{ steps: Array<{ step: string; ok: boolean; detail: string }> }> {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("sandbox_disabled");
    const files = resolved.service.files;
    const dir = ".nadi-debug-file-tools";
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    const run = async (step: string, fn: () => Promise<string>): Promise<void> => {
      try {
        steps.push({ step, ok: true, detail: await fn() });
      } catch (error) {
        steps.push({
          step,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    };
    // Expects `fn` to throw; records ok only when it throws `expected`.
    const expectThrow = async (step: string, expected: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        steps.push({ step, ok: false, detail: `expected ${expected}, resolved instead` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ step, ok: message.includes(expected), detail: message });
      }
    };

    let hash = "";
    await run("write_file", async () => {
      const result = await files.writeFile({
        path: `${dir}/a.txt`,
        content: "keep\nold\n",
        createParents: true,
      });
      hash = result.hash;
      return `bytes=${result.bytesWritten}`;
    });
    await run("read_file round-trip", async () => {
      const result = await files.readFile({ path: `${dir}/a.txt` });
      if (result.hash !== hash) throw new Error(`hash mismatch: write=${hash} read=${result.hash}`);
      return `lines=${result.endLine} hash matches write`;
    });
    // In-place update: temp sibling moved onto an existing destination.
    await run("apply_patch in-place (movePath overwrite)", async () => {
      const patch = `*** Begin Patch\n*** Update File: ${dir}/a.txt\n@@\n keep\n-old\n+new\n*** End Patch`;
      const result = await files.applyPatch({ patch, expectedHashes: { [`${dir}/a.txt`]: hash } });
      const after = await files.readFile({ path: `${dir}/a.txt` });
      if (!after.content.includes("new")) throw new Error(`content not replaced: ${after.content}`);
      hash = after.hash;
      return `written=${result.written} content replaced`;
    });
    await expectThrow("stale patch rejected", "compute_stale_file", async () => {
      const patch = `*** Begin Patch\n*** Update File: ${dir}/a.txt\n@@\n keep\n-old\n+new\n*** End Patch`;
      return files.applyPatch({ patch, expectedHashes: { [`${dir}/a.txt`]: "stale" } });
    });
    // The `add` path, which no other step here reaches. Both directions matter,
    // and the FIRST is the one that can break every patch: the absence guard now
    // calls `pathExists`, which THROWS on a provider failure instead of reading
    // it as "absent". If the provider answers a merely-missing path in a way we
    // classify as failure, this step goes red and no `add` works at all — a
    // regression a green unit suite cannot see, because the fake is ours.
    await run("apply_patch add to a fresh path", async () => {
      const patch = `*** Begin Patch\n*** Add File: ${dir}/added.txt\n+fresh\n*** End Patch`;
      const result = await files.applyPatch({ patch, expectedHashes: {} });
      const after = await files.readFile({ path: `${dir}/added.txt` });
      if (!after.content.includes("fresh")) throw new Error(`content wrong: ${after.content}`);
      return `written=${result.written}`;
    });
    // The other direction: a real file must still be refused. On a truthful
    // provider this proves the guard fires; it cannot prove the fail-open case
    // (that needs an induced provider failure, which unit tests cover).
    await expectThrow("apply_patch add onto an existing file", "compute_patch_file_exists", () => {
      const patch = `*** Begin Patch\n*** Add File: ${dir}/added.txt\n+clobber\n*** End Patch`;
      return files.applyPatch({ patch, expectedHashes: {} });
    });
    await run("added file survived the refused add", async () => {
      const after = await files.readFile({ path: `${dir}/added.txt` });
      if (after.content.includes("clobber")) throw new Error(`CLOBBERED: ${after.content}`);
      return "content intact";
    });
    // The contract the fake cannot prove: does the provider report a symlink?
    // `exec` (not `execStart`) so the link exists before we inspect it.
    await run("seed symlink via exec", async () => {
      const result = await resolved.service.exec({
        command: `mkdir -p ${dir} && ln -sfn /etc ${dir}/link && ls -ld ${dir}/link`,
      });
      if (result.status === "backgrounded") throw new Error("seed command backgrounded");
      if (result.status !== "exited") throw new Error(`seed command ${result.status}`);
      return `${result.stdoutPreview.trim()}`;
    });
    // These two record the symlink guard's ACTUAL state rather than the state we
    // wish it had. Daytona's getFileDetails follows links (raw dump: a link to
    // /etc returns mode "drwxr-xr-x", isDir true, permissions "0755" — the
    // target's stat), so the guard is inert here and `read_file` resolves. A step
    // that always printed FAIL would train the reader to ignore this whole gate.
    // They go red only if the provider's behavior CHANGES, in either direction.
    await run("symlink guard status", async () => {
      const probe = (await resolved.service.debugInspectPath(`/workspace/${dir}/link`)) as {
        info?: { type?: string } | null;
        raw?: unknown;
      };
      const type = probe.info?.type ?? "null";
      if (type === "symlink") return `ACTIVE: provider reports symlink`;
      if (type === "directory")
        return `inert (expected on Daytona): raw=${JSON.stringify(probe.raw)}`;
      throw new Error(`unexpected type=${type} raw=${JSON.stringify(probe.raw)}`);
    });
    await run("symlink escape (inert on Daytona)", async () => {
      try {
        await files.readFile({ path: `${dir}/link/passwd` });
        return "resolved — guard inert, as documented; sandbox is the boundary";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("compute_path_escape")) return "rejected — guard ACTIVE";
        throw error;
      }
    });
    await run("cleanup", async () => {
      const result = await resolved.service.exec({ command: `rm -rf ${dir}` });
      return `status=${result.status}`;
    });
    // Destroy the sandbox: each debug thread otherwise leaks one, and the org's
    // disk quota is shared. A leaked sandbox eventually blocks every new one.
    await run("shutdown sandbox", async () => {
      const result = await resolved.service.execShutdown({ confirm: true });
      return JSON.stringify(result);
    });
    return { steps };
  }

  async debugThreadKnowledgeTools(): Promise<{
    steps: Array<{
      step: "search" | "read" | "grep" | "weekly-list" | "cleanup";
      ok: boolean;
      detail: unknown;
    }>;
  }> {
    type StepName = "search" | "read" | "grep" | "weekly-list" | "cleanup";
    type Step = { step: StepName; ok: boolean; detail: unknown };
    type ExecutableTool = { execute?: (input: unknown, options: unknown) => Promise<unknown> };
    const steps: Step[] = [];
    const prefix = `debug-thread-knowledge-${crypto.randomUUID()}`;
    const manualThreadId = `${prefix}-manual`;
    const automatonThreadId = `${prefix}-automaton`;
    const tempThreadIds = [manualThreadId, automatonThreadId];
    const runtimeConfig = await this.resolveRuntimeConfigForThink();
    const now = Date.now();
    const since = new Date(now - 60_000).toISOString();
    const until = new Date(now + 60_000).toISOString();
    const manualNeedle = `debugorchid ${prefix}`;
    const automatonNeedle = `debugautomaton ${prefix}`;
    const manualMessages = [
      {
        id: `${manualThreadId}-user`,
        role: "user",
        createdAt: now - 1_000,
        parts: [{ type: "text", text: `Manual walkthrough user prose ${manualNeedle}` }],
      },
      {
        id: `${manualThreadId}-assistant`,
        role: "assistant",
        createdAt: now,
        parts: [{ type: "text", text: `Manual walkthrough assistant prose ${manualNeedle}` }],
      },
    ];
    const automatonMessages = [
      {
        id: `${automatonThreadId}-user`,
        role: "user",
        createdAt: now,
        parts: [{ type: "text", text: `Automaton walkthrough prose ${automatonNeedle}` }],
      },
    ];
    const record = (step: StepName, ok: boolean, detail: unknown) => {
      steps.push({ step, ok, detail });
    };
    const run = async (step: StepName, fn: () => Promise<unknown>) => {
      try {
        record(step, true, await fn());
      } catch (error) {
        record(step, false, error instanceof Error ? error.message : String(error));
      }
    };
    const assertToolOk = (value: unknown) => {
      if (typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false) {
        const error = value as { code?: unknown; message?: unknown };
        throw new Error(`${String(error.code)}: ${String(error.message)}`);
      }
    };
    const createSeedThread = async (input: {
      threadId: string;
      title: string;
      source: "manual" | "automaton";
    }) => {
      await registryBinding(this.env)
        .prepare(
          `
          INSERT INTO thread_index (
            id, workspace_id, agent_id, title, title_set, runtime, source,
            automaton_id, automaton_run_id, last_event_id, last_message_preview,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 1, 'think', ?, ?, ?, NULL, '', ?, ?)
        `,
        )
        .bind(
          input.threadId,
          runtimeConfig.workspaceId,
          runtimeConfig.agentId,
          input.title,
          input.source,
          input.source === "automaton" ? `auto-${input.threadId}` : null,
          input.source === "automaton" ? `run-${input.threadId}` : null,
          now,
          now,
        )
        .run();
    };
    const appendMessages = async (threadId: string, messages: unknown[]) => {
      const stub = (await getAgentByName(this.env.THINK_THREAD_AGENT, threadId)) as unknown as {
        addMessages(messages: unknown[]): Promise<void>;
      };
      await stub.addMessages(messages);
    };
    const tools = createBaseNativeThreadTools({
      env: this.env,
      threadId: this.name,
      resolveThreadKnowledgeScope: async () => {
        const config = await this.resolveRuntimeConfigForThink();
        return { workspaceId: config.workspaceId, callerThreadId: this.name };
      },
    }) as Record<string, ExecutableTool>;
    const callTool = async <T>(name: string, input: unknown): Promise<T> => {
      const execute = tools[name]?.execute;
      if (!execute) throw new Error(`missing tool ${name}`);
      const value = await execute(input, {} as never);
      assertToolOk(value);
      return value as T;
    };

    try {
      await createSeedThread({
        threadId: manualThreadId,
        title: "Debug thread knowledge manual seed",
        source: "manual",
      });
      await createSeedThread({
        threadId: automatonThreadId,
        title: "Debug thread knowledge automaton seed",
        source: "automaton",
      });
      await appendMessages(manualThreadId, manualMessages);
      await appendMessages(automatonThreadId, automatonMessages);
      await reconcileThreadSearchProjection(this.env, manualThreadId);

      await run("search", async () => {
        const result = await callTool<{
          results: Array<{ thread: { id: string }; excerpts: Array<{ text: string }> }>;
        }>("search_threads", { query: "debugorchid", since, until, limit: 5 });
        const hit = result.results.find((item) => item.thread.id === manualThreadId);
        if (!hit?.excerpts.some((excerpt) => excerpt.text.includes(manualNeedle))) {
          throw new Error("manual search excerpt missing");
        }
        return { threadId: manualThreadId, excerpts: hit.excerpts.length };
      });
      await run("read", async () => {
        const result = await callTool<{
          messages: Array<{ text: string }>;
          limited: boolean;
          nextCursor?: string;
        }>("read_thread", { threadId: manualThreadId, since, until, limit: 50 });
        const texts = result.messages.map((message) => message.text);
        if (!texts.some((text) => text.includes(`user prose ${manualNeedle}`))) {
          throw new Error("manual user prose missing");
        }
        if (!texts.some((text) => text.includes(`assistant prose ${manualNeedle}`))) {
          throw new Error("manual assistant prose missing");
        }
        return {
          messageCount: result.messages.length,
          limited: result.limited,
          nextCursor: result.nextCursor ?? null,
        };
      });
      await run("grep", async () => {
        const result = await callTool<{ matches: Array<{ text: string }>; limited: boolean }>(
          "grep_thread",
          { threadId: manualThreadId, pattern: "debugorchid", since, until },
        );
        if (!result.matches.some((match) => match.text.includes(manualNeedle))) {
          throw new Error("manual grep match missing");
        }
        return { matchCount: result.matches.length, limited: result.limited };
      });
      await run("weekly-list", async () => {
        const result = await callTool<{ threads: Array<{ id: string; source: string }> }>(
          "list_threads",
          { since, until, limit: 10 },
        );
        const ids = result.threads.map((thread) => thread.id);
        if (!ids.includes(manualThreadId)) throw new Error("manual seed missing from list");
        if (ids.includes(automatonThreadId)) throw new Error("automaton seed leaked into list");
        return { ids, sources: result.threads.map((thread) => thread.source) };
      });
    } finally {
      const errors: string[] = [];
      for (const threadId of tempThreadIds) {
        try {
          const stub = this.env.THINK_THREAD_AGENT.get(
            this.env.THINK_THREAD_AGENT.idFromName(threadId),
          ) as unknown as { destroy(): Promise<void> };
          await stub.destroy();
        } catch {
          // destroy() aborts the isolate after clearing storage; deletion below
          // removes registry/projected state even when that expected abort occurs.
        }
      }
      try {
        const placeholders = tempThreadIds.map(() => "?").join(", ");
        await registryBinding(this.env).batch([
          registryBinding(this.env)
            .prepare(`DELETE FROM thread_search_messages WHERE thread_id IN (${placeholders})`)
            .bind(...tempThreadIds),
          registryBinding(this.env)
            .prepare(`DELETE FROM archived_message WHERE thread_id IN (${placeholders})`)
            .bind(...tempThreadIds),
          registryBinding(this.env)
            .prepare(`DELETE FROM archived_compaction WHERE thread_id IN (${placeholders})`)
            .bind(...tempThreadIds),
          registryBinding(this.env)
            .prepare(`DELETE FROM thread_index WHERE id IN (${placeholders})`)
            .bind(...tempThreadIds),
        ]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      record("cleanup", errors.length === 0, { threadIds: tempThreadIds, errors });
    }
    return { steps };
  }

  /** Destroy this thread's sandbox (reclaim the org's shared disk quota). */
  async debugShutdown(): Promise<unknown> {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("sandbox_disabled");
    return resolved.service.execShutdown({ confirm: true });
  }

  /**
   * Drive the LIVE Cloudflare Sandbox provider through every contract a fake can
   * only assert (see `runCloudflareComputeSmoke`). Constructs the Cloudflare
   * backend DIRECTLY — never via the thread's configured provider, which may be
   * Daytona — so it exercises the real container regardless of settings. Each run
   * creates a REAL container and costs money; the orchestrator self-cleans in a
   * `finally`, and `debugCloudflareShutdown` reclaims a wedged one out of band.
   */
  async debugCloudflareCompute(): Promise<{
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  }> {
    const { workspaceId } = await this.resolveRuntimeConfigForThink();
    const threadId = this.name;
    // Fail with a clear step (not a throw) when the bindings are absent, so the
    // instrument reports "not deployable" instead of a 500.
    const missing = (
      ["NADI_SANDBOX_SMALL", "NADI_SANDBOX_MEDIUM", "BACKUP_BUCKET"] as const
    ).filter((name) => !(this.env as unknown as Record<string, unknown>)[name]);
    if (missing.length > 0) {
      return {
        steps: [
          {
            step: "0. cloudflare bindings present",
            ok: false,
            detail: `absent bindings: ${missing.join(", ")} — deploy with Cloudflare compute configured`,
          },
        ],
      };
    }
    // Build ONE factory and share it between the backend and the raw-SDK probe so
    // both resolve the SAME Durable Object behind the derived sandbox id.
    const { createCloudflareSandboxFactory } =
      await import("../compute/backends/cloudflare-client");
    const factory = createCloudflareSandboxFactory();
    const bindings = { small: this.env.NADI_SANDBOX_SMALL, medium: this.env.NADI_SANDBOX_MEDIUM };
    const backend = new CloudflareComputeBackend({
      factory,
      bindings,
      workspaceId,
      threadId,
      useLocalBucket: false,
    });
    const sandboxId = deriveSandboxId(workspaceId, threadId);
    const directSandbox = factory.get(bindings.small, sandboxId, {
      enableDefaultSession: false,
      keepAlive: true,
    });
    const spec: ComputeSpec = {
      environmentId: "cloudflare:small",
      profile: "small",
      workspaceRoot: "/workspace",
      env: { NADI_CF_SMOKE: "phase-1" },
      maxProcessRuntimeMs: 60_000,
      allowedHosts: null,
    };
    return runCloudflareComputeSmoke({
      backend,
      directSandbox,
      readiness: computeProviderReadiness({
        env: this.env,
        provider: "cloudflare",
        networkRestricted: false,
      }),
      expectedSandboxId: sandboxId,
      environmentId: spec.environmentId,
      spec,
    });
  }

  /**
   * Out-of-band cleanup for a wedged Cloudflare smoke run: destroy the derived
   * derived (workspace, thread) container on each configured binding. Never
   * touches the thread's configured provider.
   */
  async debugCloudflareShutdown(): Promise<{
    sandboxId: string;
    destroyed: string[];
    errors: string[];
  }> {
    const { workspaceId } = await this.resolveRuntimeConfigForThink();
    const sandboxId = deriveSandboxId(workspaceId, this.name);
    const { createCloudflareSandboxFactory } =
      await import("../compute/backends/cloudflare-client");
    const factory = createCloudflareSandboxFactory();
    const destroyed: string[] = [];
    const errors: string[] = [];
    const bindings: Array<[string, unknown]> = [
      ["small", this.env.NADI_SANDBOX_SMALL],
      ["medium", this.env.NADI_SANDBOX_MEDIUM],
    ];
    for (const [name, binding] of bindings) {
      if (!binding) continue;
      try {
        await factory
          .get(binding, sandboxId, { enableDefaultSession: false, keepAlive: true })
          .destroy();
        destroyed.push(name);
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { sandboxId, destroyed, errors };
  }

  /**
   * The model-facing fault text for one work id, read back from the thread's OWN
   * messages. Delivery is the property under test in both debug runs below, and
   * a closed ledger row does not prove it — the row is written before
   * `deliverInjection` and survives a delivery that never happened. So both runs
   * assert on this, never on the row alone.
   *
   * Matches the two REAPER fault sentences from `buildFaultMessage` (and only
   * those): a clean exit's completion card also carries the process id, so an
   * id-only match would report every healthy exit as a fault.
   */
  private findWorkFaultText(id: string): string | null {
    for (const message of this.messages.slice(-25)) {
      const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
      if (!text.includes(id)) continue;
      if (text.includes("the sandbox was reset") || text.includes("showed no liveness signal"))
        return text;
    }
    return null;
  }

  /**
   * Best-effort teardown shared by the two live work-ledger runs below. Each run
   * boots a REAL container that costs money, and the SDK cannot enumerate
   * containers — so cleanup is by-id, and a failure is recorded as a failed step
   * rather than swallowed. `execShutdown` first (it also releases the D1 quota
   * row); the by-id destroy is the backstop for when it throws.
   */
  private async debugSelfClean(
    provider: string,
    step: (name: string, ok: boolean, detail: string) => void,
  ): Promise<void> {
    try {
      const resolved = await resolveComputeService(this.sandboxHostDeps());
      const result = await resolved?.service.execShutdown({ confirm: true });
      step("clean: execShutdown", true, JSON.stringify(result ?? { skipped: "compute_disabled" }));
    } catch (error) {
      step(
        "clean: execShutdown",
        false,
        `FAILED — ${error instanceof Error ? error.message : String(error)}. A container may still be running; call POST /api/debug/cloudflare-shutdown.`,
      );
    }
    if (provider !== "cloudflare") return;
    try {
      const cleaned = await this.debugCloudflareShutdown();
      step(
        "clean: destroy container by id",
        cleaned.errors.length === 0,
        `destroyed=[${cleaned.destroyed.join(",")}] errors=[${cleaned.errors.join("; ")}]`,
      );
    } catch (error) {
      step(
        "clean: destroy container by id",
        false,
        `FAILED — ${error instanceof Error ? error.message : String(error)}. Call POST /api/debug/cloudflare-shutdown.`,
      );
    }
  }

  /**
   * Prove against a REAL container that a sandbox reset is DETECTED and REPORTED
   * to the model. `FakeComputeBackend` cannot OOM, so no unit test can settle
   * this; this run is the verification.
   *
   * What it actually drives, and why each step is the honest one:
   *
   *  1. `execStart` a long process, then `execWatch` it. `execStart` alone does
   *     NOT attach a watcher — `execWatch` is what registers the ledger row, so
   *     without it there is nothing for the reaper to classify.
   *  2. Destroy the derived (workspace, thread) container out of band
   *     (the `/cloudflare-shutdown` path), leaving the row open and the watcher
   *     armed. The container is genuinely gone at this point.
   *  3. Wait for the watcher's own failing poll to PROBE the container. This
   *     step used to force a re-provision via a bare `execStart`, on the theory
   *     that `sandbox_reset` needs a diverged nonce. The 2026-07-16 live run
   *     killed that theory: after `.destroy()` the SDK silently handed back a
   *     WORKING container on the same sandbox id — `execStart` returned a
   *     RUNNING process and never threw `SandboxNotFound` — so the DO never
   *     re-provisioned, the nonce never diverged, and `resetPathExercised` came
   *     back false. Re-provision is not a lever we have.
   *
   *     What a real reset DOES leave is the wiped filesystem: the container
   *     answers, and its nonce is gone. `readGeneration` reports that as
   *     `absent` and the poll-failure probe acts on it — no re-provision
   *     anywhere.
   *
   *     Since `restoreGenerationAfterWipe` shipped, that probe also RESTORES the
   *     nonce in the same call, so `absent` is normally never left on record for
   *     this run to observe: the store goes `absent` -> `known(fresh)` in one
   *     step, and the reset is detected on the `known` arm (the pre-wipe row's
   *     nonce diverges from the restored one) rather than the `absent` arm. Both
   *     arms are genuine resets and both close the row as `sandbox_reset`; step
   *     5 reports WHICH, and `generationDiverged` is named for the divergence it
   *     observes rather than claiming a re-provision it cannot witness.
   *
   * The run still REPORTS which path fired (`resetPathExercised`) rather than
   * dressing a `no_liveness` up as a reset. Both outcomes terminalize and both
   * tell the model; only `sandbox_reset` proves the reset path.
   *
   * ⚠️ Boots a REAL Cloudflare container that costs money. Self-cleans in a
   * `finally`. Never run it in a loop.
   */
  async debugSandboxReset(): Promise<{
    provider: string;
    processId: string;
    generationBefore: string | null;
    generationAfter: string | null;
    generationState: CurrentGeneration["kind"];
    generationDiverged: boolean;
    resetPathExercised: boolean;
    outcome: string | null;
    reason: string | null;
    reminderDelivered: boolean;
    reminderText: string | null;
    terminalViaExplicitSweep: boolean;
    // Task 5 probe: the RAW SDK `listFiles("/tmp")` answer, never routed through
    // `inspectPath`/`isPathNotFound` — see the method doc for why the two are
    // never allowed to converge here.
    postResetListing:
      | { ok: true; entries: string[] }
      | { ok: false; errorName?: string; errorMessage: string }
      | null;
    elapsedMs: number;
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  }> {
    const startedAt = Date.now();
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    const step = (name: string, ok: boolean, detail: string) => {
      steps.push({ step: name, ok, detail });
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let processId = "";
    let generationBefore: string | null = null;
    let generationAfter: string | null = null;
    let generationState: CurrentGeneration["kind"] = "unknown";
    let generationDiverged = false;
    let outcome: string | null = null;
    let reason: string | null = null;
    let postResetListing:
      | { ok: true; entries: string[] }
      | { ok: false; errorName?: string; errorMessage: string }
      | null = null;
    let reminderDelivered = false;
    let reminderText: string | null = null;
    let terminalViaExplicitSweep = false;

    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("sandbox_disabled");
    const service = resolved.service;
    const provider = resolved.config.provider;
    const result = () => ({
      provider,
      processId,
      generationBefore,
      generationAfter,
      generationState,
      // "A nonce is on record that is NOT the one this run started with." That
      // is the OBSERVABLE, and it is all this field ever measured — it was
      // called `reprovisioned` when a divergence could only come from a
      // re-provision. Since `restoreGenerationAfterWipe` shipped, the expected
      // source is a RESTORE on the same live container, so the old name asserted
      // a provision that did not happen. See step 5 for why no field here claims
      // one: the DO has no post-hoc signal that witnesses a provision (the CF
      // runtime ref is deterministic — same sandbox id — and `createdAt`,
      // `generation` and `generation_absent_at` all end up identical either
      // way). `acquireCalls` exists only on the unit-test fake, where
      // `watcher-fault.test.ts` does assert it stays 1 across a restore.
      generationDiverged,
      // Never inferred from the probe — read from the terminal the model was
      // actually told about. A probe that saw `absent` still proves nothing if
      // the row did not close as a reset.
      resetPathExercised: reason === "sandbox_reset",
      outcome,
      reason,
      reminderDelivered,
      reminderText,
      terminalViaExplicitSweep,
      postResetListing,
      elapsedMs: Date.now() - startedAt,
      steps,
    });

    // The forced reset destroys the derived CLOUDFLARE container. On any other
    // provider that container is not this thread's runtime, so the run would
    // destroy nothing and prove nothing. Fail as a step, before provisioning.
    if (provider !== "cloudflare") {
      step(
        "0. thread compute provider is cloudflare",
        false,
        `provider is "${provider}" — this run destroys the derived (workspace, thread) Cloudflare container, which is NOT this thread's runtime. Point the workspace at Cloudflare compute and re-run.`,
      );
      return result();
    }

    try {
      const started = await service.execStart({ command: "sleep 300 && echo NEVER" });
      processId = started.processId;
      step(
        "1. start long background process",
        started.status === "running",
        `processId=${processId} status=${started.status}`,
      );

      // execStart does NOT attach a watcher; execWatch is what registers the
      // ledger row the reaper classifies. Without this the run tests nothing.
      const watch = await service.execWatch({ processId });
      step(
        "2. arm watcher (registers the ledger row)",
        watch.watching === true,
        JSON.stringify(watch),
      );

      generationBefore = service.getGeneration();
      const rowBefore = this.workLedger.get(processId);
      step(
        "3. read generation + open ledger row",
        generationBefore !== null &&
          rowBefore !== null &&
          rowBefore.terminal === null &&
          rowBefore.generation === generationBefore,
        `generationBefore=${generationBefore} rowGeneration=${rowBefore?.generation ?? "no-row"} rowOpen=${rowBefore !== null && rowBefore.terminal === null}`,
      );

      const destroyed = await this.debugCloudflareShutdown();
      step(
        "4. destroy the real container out of band",
        destroyed.destroyed.length > 0 && destroyed.errors.length === 0,
        `sandboxId=${destroyed.sandboxId} destroyed=[${destroyed.destroyed.join(",")}] errors=[${destroyed.errors.join("; ")}]`,
      );

      // Nothing to force here: the armed watcher's next poll fails against the
      // destroyed container, and THAT is what probes the nonce. Read the store
      // (never the backend) until the probe lands. A fresh service instance per
      // read, because the probe persists to the store and this proves a
      // different instance can see it — the same property the reaper relies on.
      // Keep waiting through `unknown`, not just through an unchanged nonce: a
      // probe can read unreadable (a transient blip) before it reads the wipe,
      // and exiting on the first `unknown` reported "the probe learned nothing"
      // for a run whose next poll was about to observe `absent` — a flaky gate,
      // not a real negative. Only a settled answer ends the wait: `absent`, or a
      // nonce that actually DIVERGED.
      const probeDeadline = Date.now() + 30_000;
      let view = service.getGenerationView();
      const unsettled = (v: CurrentGeneration) =>
        v.kind === "unknown" || (v.kind === "known" && v.nonce === generationBefore);
      while (Date.now() < probeDeadline && unsettled(view)) {
        await sleep(2_000);
        view = (
          await resolveComputeService(this.sandboxHostDeps())
        )?.service.getGenerationView() ?? {
          kind: "unknown",
        };
      }
      generationAfter = view.kind === "known" ? view.nonce : null;
      generationState = view.kind;
      generationDiverged = view.kind === "known" && view.nonce !== generationBefore;
      const wiped = view.kind === "absent";
      step(
        "5. the poll-failure probe observes the wiped container",
        wiped || generationDiverged,
        `generationState=${view.kind} generationAfter=${generationAfter} generationBefore=${generationBefore}` +
          (generationDiverged
            ? " — the nonce DIVERGED: a fresh nonce is on record. Since restoreGenerationAfterWipe shipped this is the EXPECTED path and it is a RESTORE, not a re-provision: the poll-failure probe saw the container answer with its nonce gone, wrote a new one to that same live container, and persisted it — all inside one probe call, so `absent` is never left on record for this loop to catch. The reset is then detected on the `known` arm (the pre-wipe row carries generationBefore, the store carries this nonce, they diverge). Nothing re-provisioned: CF hands back a WORKING container on the same sandbox id, so nothing throws SandboxNotFound and readOrAcquireRuntime early-returns on status=active. A genuine re-provision would leave the same divergence and is NOT distinguishable here — this field claims only the divergence it can see."
            : wiped
              ? " — the container ANSWERED with its nonce gone and the absence is on record: a real reset with positive evidence for the reaper, and no re-provision. Post-fix this means the RESTORE WRITE FAILED (the probe records the absence and retries on the next poll failure); the reaper still classifies it as the reset it is, via the `absent` arm."
              : " — the probe learned nothing (unknown, or the nonce is unchanged). Either the watcher's polls are still succeeding, or the probe read as unreadable; this run will degrade to the no_liveness path, NOT sandbox_reset."),
      );

      // Task 5 probe (item 1 gate): call the RAW SDK `listFiles("/tmp")`
      // directly — NOT through `inspectPath`, whose whole job is to erase the
      // distinction between "answered with no entry" and "threw a
      // not-found-shaped message". Task 6 is blocked on which of those two
      // routes a genuinely wiped container actually takes; report both the
      // entry names and the raw throw verbatim, unclassified. Wrapped so a
      // probe failure never takes down the rest of this response.
      try {
        const sandboxId = deriveSandboxId(resolved.workspaceId, this.name);
        const { createCloudflareSandboxFactory } =
          await import("../compute/backends/cloudflare-client");
        const factory = createCloudflareSandboxFactory();
        const bindings = {
          small: this.env.NADI_SANDBOX_SMALL,
          medium: this.env.NADI_SANDBOX_MEDIUM,
        };
        const directSandbox = factory.get(bindings[resolved.config.resourceProfile], sandboxId, {
          enableDefaultSession: false,
          keepAlive: true,
        });
        // includeHidden is load-bearing: the nonce file is dot-prefixed
        // (`.nadi-generation`) and the container server omits dotfiles
        // without it — omitting it would manufacture a false "absent".
        const listing = await directSandbox.listFiles("/tmp", { includeHidden: true });
        const names = listing.files.map((entry) => entry.name);
        // `success` is part of the raw answer: an in-band failure is NOT an
        // empty /tmp, and this probe exists to record what really came back.
        if (listing.success) {
          postResetListing = { ok: true, entries: names };
          step("5b. raw listFiles(/tmp) after reset", true, `entries=[${names.join(", ")}]`);
        } else {
          const errorMessage = `listFiles reported success: false (files=[${names.join(", ")}])`;
          postResetListing = { ok: false, errorMessage };
          step("5b. raw listFiles(/tmp) after reset", false, errorMessage);
        }
      } catch (error) {
        const name =
          typeof error === "object" && error !== null && "name" in error
            ? String((error as { name: unknown }).name)
            : undefined;
        const errorMessage = String(error);
        postResetListing = {
          ok: false,
          errorMessage,
          ...(name !== undefined ? { errorName: name } : {}),
        };
        step(
          "5b. raw listFiles(/tmp) after reset",
          false,
          `THREW — errorName=${name} message=${errorMessage}`,
        );
      }

      // Wait for the ALARM-driven terminal. Store reads only — never a backend
      // call — so this loop cannot wedge on the container we just destroyed.
      const deadline = Date.now() + 60_000;
      let row = this.workLedger.get(processId);
      while (Date.now() < deadline) {
        row = this.workLedger.get(processId);
        if (row?.terminal) break;
        await sleep(2_000);
      }
      if (row?.terminal) {
        step(
          "6. alarm-driven terminal",
          true,
          `terminal after ${Date.now() - startedAt}ms: ${JSON.stringify(row.terminal)}`,
        );
      } else {
        // Distinguish "classification is broken" from "the alarm never fired" —
        // run the sweep the alarm would have run and LABEL it as the fallback.
        const swept = await this.runWorkLedgerSweep();
        terminalViaExplicitSweep = swept.terminalized.includes(processId);
        row = this.workLedger.get(processId);
        step(
          "6. alarm-driven terminal",
          false,
          `no terminal within 60s. An explicit runWorkLedgerSweep() ${terminalViaExplicitSweep ? "DID" : "did NOT"} terminalize it: ${JSON.stringify(swept.classified)}. A terminal only via the explicit sweep means classification works but the ALARM never fired.`,
        );
      }
      outcome = row?.terminal?.outcome ?? null;
      reason = row?.terminal?.reason ?? null;
      step(
        "7. ledger row closed with a terminal",
        row?.terminal != null,
        `outcome=${outcome} reason=${reason}`,
      );

      // Delivery is read from the thread's MESSAGES, not inferred from the row.
      const messageDeadline = Date.now() + 20_000;
      while (Date.now() < messageDeadline) {
        reminderText = this.findWorkFaultText(processId);
        if (reminderText !== null) break;
        await sleep(2_000);
      }
      reminderDelivered = reminderText !== null;
      step(
        "8. fault reminder delivered to the thread",
        reminderDelivered,
        reminderDelivered
          ? `delivered: ${reminderText}`
          : "NO message mentioning this process reached the thread — the row closed but the model was never told.",
      );
      step(
        "9. the reset path was exercised",
        reason === "sandbox_reset",
        reason === "sandbox_reset"
          ? "reason=sandbox_reset — a real reset was detected and reported."
          : `reason=${reason} — the probe never produced positive reset evidence (generationState=${generationState}), so this degraded to the ${reason} path. The sandbox_reset path was NOT exercised by this run.`,
      );
    } catch (error) {
      step(
        "unexpected error",
        false,
        `${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ""}`,
      );
    } finally {
      await this.debugSelfClean(provider, step);
    }
    return result();
  }

  /**
   * The other direction, and it matters as much: a HEALTHY long run must NOT be
   * faulted. Enforcement ships live (there is no dark ship), so a false fault
   * would tell the model its files are gone while the work is fine — and the
   * reaper's `no_liveness` window (`PROCESS_STALE_AFTER_MS`) is shorter than
   * plenty of real commands.
   *
   * Runs a process PAST `PROCESS_STALE_AFTER_MS` with the watcher polling
   * normally, then asserts three things the fake cannot: the row is still open
   * after the stale window, the watcher's polls actually STAMPED it (an unstamped
   * row is faulted once `PROCESS_STALE_AFTER_MS` passes — this is the false-fault
   * mechanism), and the clean exit closes the row as `process_exit` with no fault
   * message delivered.
   *
   * The sleep is CLAMPED UP to outlive the stale window, and the bound is
   * derived from `PROCESS_STALE_AFTER_MS` rather than written out: it was a
   * literal `25..120`, and widening the watcher poll (which
   * `PROCESS_STALE_AFTER_MS` is 3x of) moved the window to 180s — past the
   * clamp's own ceiling, so the process always exited before step 3 could
   * check the row and the probe silently stopped proving anything.
   *
   * ⚠️ Boots a REAL container that costs money, and now runs for over three
   * minutes because the window it must outlive is that long. Self-cleans.
   * Never loop it.
   */
  async debugWorkHealthy(sleepSeconds = 30): Promise<{
    provider: string;
    processId: string;
    generation: string | null;
    aliveAfterStaleWindow: boolean;
    stampAdvancedMs: number;
    outcome: string | null;
    reason: string | null;
    faultDelivered: boolean;
    faultText: string | null;
    elapsedMs: number;
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  }> {
    const startedAt = Date.now();
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    const step = (name: string, ok: boolean, detail: string) => {
      steps.push({ step: name, ok, detail });
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Must outlive the stale window AND the moment step 3 reads the row
    // (`PROCESS_STALE_AFTER_MS + 6s`, below), or the run proves nothing —
    // so both ends of the clamp are derived from that, never from a literal.
    // The floor is the check point plus slack for start-up and the exit poll;
    // the ceiling only exists to stop a caller booking an hour of container.
    const minSeconds = Math.ceil((PROCESS_STALE_AFTER_MS + 6_000) / 1_000) + 15;
    const seconds = Math.min(Math.max(Math.round(sleepSeconds), minSeconds), minSeconds * 2);

    let processId = "";
    let generation: string | null = null;
    let aliveAfterStaleWindow = false;
    let stampAdvancedMs = 0;
    let outcome: string | null = null;
    let reason: string | null = null;
    let faultText: string | null = null;

    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("sandbox_disabled");
    const service = resolved.service;
    const provider = resolved.config.provider;

    try {
      const started = await service.execStart({ command: `sleep ${seconds} && echo HEALTHY_DONE` });
      processId = started.processId;
      step(
        "1. start a long healthy process",
        started.status === "running",
        `processId=${processId} status=${started.status} sleepSeconds=${seconds}`,
      );

      const watch = await service.execWatch({ processId });
      step(
        "2. arm watcher (registers the ledger row)",
        watch.watching === true,
        JSON.stringify(watch),
      );
      generation = service.getGeneration();
      const registeredAt = this.workLedger.get(processId)?.lastAliveAt ?? startedAt;

      // Run past the stale window while the watcher polls normally.
      const checkAt = Date.now() + PROCESS_STALE_AFTER_MS + 6_000;
      while (Date.now() < checkAt) {
        if (this.workLedger.get(processId)?.terminal) break;
        await sleep(2_000);
      }
      const rowMid = this.workLedger.get(processId);
      aliveAfterStaleWindow = rowMid !== null && rowMid.terminal === null;
      stampAdvancedMs = rowMid ? rowMid.lastAliveAt - registeredAt : 0;
      step(
        `3. row still alive past PROCESS_STALE_AFTER_MS (${PROCESS_STALE_AFTER_MS}ms)`,
        aliveAfterStaleWindow,
        `elapsed=${Date.now() - startedAt}ms terminal=${JSON.stringify(rowMid?.terminal ?? null)}`,
      );
      step(
        "4. watcher polls stamped the row",
        stampAdvancedMs > 0,
        `lastAliveAt advanced by ${stampAdvancedMs}ms. A row nothing stamps is faulted no_liveness at ${PROCESS_STALE_AFTER_MS}ms — this is the false-fault mechanism.`,
      );

      // Let it exit cleanly. The terminal must be process_exit, never a fault.
      const exitDeadline = Date.now() + seconds * 1_000 + 30_000;
      let row = this.workLedger.get(processId);
      while (Date.now() < exitDeadline) {
        row = this.workLedger.get(processId);
        if (row?.terminal) break;
        await sleep(2_000);
      }
      outcome = row?.terminal?.outcome ?? null;
      reason = row?.terminal?.reason ?? null;
      step(
        "5. clean exit closes the row as process_exit",
        outcome === "exited" && reason === "process_exit",
        `outcome=${outcome} reason=${reason} after ${Date.now() - startedAt}ms`,
      );

      faultText = this.findWorkFaultText(processId);
      step(
        "6. NO fault was delivered to the model",
        faultText === null,
        faultText === null
          ? "no sandbox_reset / no_liveness message reached the thread."
          : `FALSE FAULT — the model was told: ${faultText}`,
      );
    } catch (error) {
      step(
        "unexpected error",
        false,
        `${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ""}`,
      );
    } finally {
      await this.debugSelfClean(provider, step);
    }

    return {
      provider,
      processId,
      generation,
      aliveAfterStaleWindow,
      stampAdvancedMs,
      outcome,
      reason,
      faultDelivered: faultText !== null,
      faultText,
      elapsedMs: Date.now() - startedAt,
      steps,
    };
  }

  /** Directly dispatch a subagent with a fixed task (no model turn). */
  async debugSpawnSubagent(
    task: string,
    label?: string,
  ): Promise<{ runId: string } | { error: string }> {
    return this.spawnSubagent({ task, ...(label ? { label } : {}), toolCallId: "debug" });
  }

  /** Inspect the parent's subagent bookkeeping (timings + active leases). Both
   *  are now views over the work ledger, so they cannot disagree. */
  async debugSubagentState(): Promise<{
    timings: Record<string, { startedAt: number; finishedAt?: number }>;
    leases: string[];
  }> {
    return { timings: this.subagentRunTimings(), leases: this.openSubagentRunIds() };
  }

  /** Recent message texts (to read a subagent's injected completion). */
  /**
   * DEBUG: the raw compaction overlay rows. Every row after the first is supposed
   * to reuse the FIRST row's `fromMessageId` so they collapse to one summary when
   * history is rebuilt. A thread showing two "Thread compacted" dividers has two
   * distinct anchors — this is how you see that, instead of inferring it.
   */
  /**
   * DEBUG: the DURABLE view (session.getHistory(), overlays applied at read time)
   * next to the CACHED view (`this.messages`, which is what the model prompt and
   * the UI are actually built from). If these disagree, the model is reading
   * something storage does not contain.
   */
  async debugCompareViews(): Promise<{
    durable: string[];
    cached: string[];
    durableOverlays: number;
    cachedOverlays: number;
  }> {
    const durable = (await this.session.getHistory()).map((m) => m.id);
    const cached = this.messages.map((m) => m.id);
    const isOverlay = (id: string) => id.startsWith("compaction_");
    return {
      durable,
      cached,
      durableOverlays: durable.filter(isOverlay).length,
      cachedOverlays: cached.filter(isOverlay).length,
    };
  }

  /**
   * DEBUG: the RAW stored path — the message rows themselves, before compaction
   * overlays are applied at read time. A `compaction_*` id in here means a
   * synthetic overlay was written back into storage as a real message, which
   * would make it render twice: once as itself, once as the overlay.
   */
  /**
   * REPAIR: remove compaction overlays that were wrongly persisted as real
   * messages (see the `_persistIncomingMessage` override for how they got there).
   *
   * Messages are a parent-linked chain, so the row cannot simply be deleted — its
   * children would be orphaned and every message after it would drop out of the
   * path. Re-parent the children onto the overlay's own parent first, THEN delete.
   */
  async debugPurgePersistedOverlays(): Promise<{ purged: string[] }> {
    const rows = this.sql<{ id: string; parent_id: string | null }>`
      SELECT id, parent_id FROM assistant_messages WHERE id LIKE 'compaction_%'
    `;
    const purged: string[] = [];
    for (const row of rows) {
      // Children first: without this the delete severs the chain.
      if (row.parent_id === null) {
        this.sql`UPDATE assistant_messages SET parent_id = NULL WHERE parent_id = ${row.id}`;
      } else {
        this
          .sql`UPDATE assistant_messages SET parent_id = ${row.parent_id} WHERE parent_id = ${row.id}`;
      }
      this.sql`DELETE FROM assistant_messages WHERE id = ${row.id}`;
      purged.push(row.id);
    }
    if (purged.length > 0) {
      log.warn("think_thread.persisted_overlays_purged", { threadId: this.name, purged });
      await (this as unknown as { _syncMessages(): Promise<void> })._syncMessages();
    }
    return { purged };
  }

  async debugRawPath(): Promise<Array<{ id: string; bytes: number }>> {
    const stats = await (
      this.session as unknown as {
        getHistoryRowStats(): Promise<Array<{ id: string; bytes: number }>>;
      }
    ).getHistoryRowStats();
    return stats.map((r) => ({ id: r.id, bytes: r.bytes }));
  }

  /** Full ledger dump for auditing sweep/classification accuracy — no filtering. */
  async debugWorkLedger(): Promise<{ rows: WorkRow[] }> {
    return { rows: this.workLedger.listAll() };
  }

  async debugReadCompactions(): Promise<
    Array<{ id: string; fromMessageId: string; toMessageId: string; summaryHead: string }>
  > {
    const rows = await this.session.getCompactions();
    return rows.map((r) => ({
      id: r.id,
      fromMessageId: r.fromMessageId,
      toMessageId: r.toMessageId,
      summaryHead: (r.summary ?? "").slice(0, 60),
    }));
  }

  /**
   * DEBUG: seed enough synthetic history to make a REAL compaction genuinely
   * necessary for this thread's resolved model, then force a REAL compaction
   * (the same `session.compact()` call `compactThread()` makes) and report the
   * outcome. Verifies, against a live provider, that a real compaction writes a
   * `compaction`-source ledger row attributed to whichever model actually served
   * the summarizer (the thread's own model, or the keyless Workers AI fallback —
   * see `generateInternalText`), and that it never masquerades a failed
   * summarizer as "nothing to compact."
   *
   * The seed size is DERIVED from the resolved budget (never hardcoded): enough
   * messages, of a size chosen so their combined estimate comfortably clears
   * `compactAfterTokens`, so this cannot silently no-op on a huge-window model
   * the way a flat message count would (a 1M-window thread's trigger is 694,400
   * tokens — a handful of small seed messages would leave the middle empty).
   *
   * `session.compact()` itself does not gate on the threshold (that gate only
   * runs inside `appendMessage`'s auto-compaction check) — it always attempts to
   * summarize whatever middle span `createNadiCompactFunction` finds. Seeding
   * past the threshold is still the point: it proves the SAME history that would
   * have tripped the auto-trigger truly can be compacted, not just that the
   * function runs on trivial input.
   */
  async debugSeedAndCompact(): Promise<{
    provider: string;
    model: string;
    budget: { contextWindow: number; compactAfterTokens: number };
    seeded: { messages: number; estimatedTokens: number };
    compacted: boolean;
    outcome: CompactionOutcome | null;
  }> {
    await this.assertThreadWritable();
    // Resolved (not the agent's configured default): a debug thread created
    // with an override provider/model reads its OWN `thread_index` snapshot,
    // so this is what the compaction below actually ran against.
    const { provider, model } = (await this.resolveRuntimeConfigForThink()).modelConfig;
    const budget = await this.currentContextBudget();

    // Target comfortably past the trigger (1.3x) so the seeded history would
    // have tripped auto-compaction too, not just satisfy compact()'s own
    // "is there a middle span" gate. Spread across a fixed message count (same
    // order as compaction.test.ts's synthetic history) so the summarizer sees
    // distinct turns rather than one giant message.
    const SEED_MESSAGE_COUNT = 60;
    const targetTotalTokens = Math.ceil(budget.compactAfterTokens * 1.3);
    const tokensPerMessage = Math.max(50, Math.ceil(targetTotalTokens / SEED_MESSAGE_COUNT));
    const charsPerMessage = tokensPerMessage * CHARS_PER_TOKEN;
    const filler = "synthetic debug-compact filler content. ".repeat(
      Math.ceil(charsPerMessage / 41),
    );

    const seedId = `debug_compact_seed_${Date.now()}`;
    const seedMessages: UIMessage[] = Array.from({ length: SEED_MESSAGE_COUNT }, (_, i) => ({
      id: `${seedId}_${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [
        {
          type: "text",
          text: `Debug compaction seed message ${i}. ${filler}`.slice(0, charsPerMessage),
        },
      ],
    }));
    // `addMessages`, not `saveMessages`: this must append durably WITHOUT
    // running a model turn (a turn would itself be a real, billed call we don't
    // want here, and would race the compaction this method triggers next).
    await this.addMessages(seedMessages);
    const estimatedTokens = estimateMessageTokens(
      seedMessages as unknown as Parameters<typeof estimateMessageTokens>[0],
    );

    // Mirrors `compactThread()` exactly (manual trigger, same finally-flush) but
    // captures the outcome instead of collapsing it into a boolean, so a no-op
    // can be diagnosed instead of just reported.
    const stable = await this.waitUntilStable({ timeout: MANUAL_COMPACT_STABLE_TIMEOUT_MS });
    if (!stable) throw new Error("thread_compaction_not_stable");
    this._compactionSource = "manual";
    this.takeLastCompactionOutcome();
    let result: Awaited<ReturnType<Session["compact"]>>;
    try {
      result = await this.session.compact();
    } finally {
      this._compactionSource = "append";
      await this.flushTurnUsage();
    }
    const outcome = this.takeLastCompactionOutcome();

    return {
      provider,
      model,
      budget: {
        contextWindow: budget.contextWindow,
        compactAfterTokens: budget.compactAfterTokens,
      },
      seeded: { messages: SEED_MESSAGE_COUNT, estimatedTokens },
      compacted: result != null,
      outcome,
    };
  }

  /**
   * One real turn against the thread's OWN resolved provider/model with an
   * attachment attached, reporting what the provider said and what it warned
   * about. Unit tests can prove our adapter emits `image_url`; only a live call
   * proves the provider accepts it and that the model can read it — the vendor
   * DeepSeek adapter dropped every image while every test stayed green.
   *
   * Deliberately outside the thread's history: `generateText`, not the chat
   * session, so a probe never persists messages or triggers compaction.
   */
  async debugVisionProbe(input: { attachmentId: string; prompt?: string }): Promise<{
    provider: string;
    model: string;
    inlined: boolean;
    text: string;
    warnings: string[];
    usage: unknown;
    error?: string;
  }> {
    const runtimeConfig = await this.resolveRuntimeConfigForThink();
    const { provider, model: modelId } = runtimeConfig.modelConfig;
    const repo = new AttachmentRepository(registryBinding(this.env));
    const row = await repo.getByIdInThread(input.attachmentId, this.name);
    if (!row) throw new Error(`attachment_not_in_thread:${input.attachmentId}`);

    // The same prepare path a real turn takes, so the probe exercises what the
    // model would actually be sent — including whether the attachment survives
    // as a file part or is replaced by extraction text.
    const messages = await this.prepareModelMessagesForThink(
      [
        {
          role: "user",
          content: [
            { type: "text", text: input.prompt ?? "Describe this image. Transcribe any text." },
            {
              type: "file",
              mediaType: row.mimeType,
              data: `/api/attachments/${input.attachmentId}`,
              ...(row.filename ? { filename: row.filename } : {}),
            },
          ],
        } as ModelMessage,
      ],
      runtimeConfig.modelConfig,
    );
    const inlined = messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => (part as { type?: string }).type === "file"),
    );

    const languageModel = await buildThreadModelForWorkspace(
      this.env,
      runtimeConfig.modelConfig,
      runtimeConfig.workspaceId,
    );

    try {
      const result = await generateText({ model: languageModel, messages });
      return {
        provider,
        model: modelId,
        inlined,
        text: result.text,
        warnings: (result.warnings ?? []).map((warning) => JSON.stringify(warning)),
        usage: result.usage,
      };
    } catch (error) {
      return {
        provider,
        model: modelId,
        inlined,
        text: "",
        warnings: [],
        usage: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async debugReadMessages(limit = 12): Promise<Array<{ id: string; role: string; text: string }>> {
    return this.messages.slice(-limit).map((m) => ({
      // The id distinguishes a synthetic compaction overlay (`compaction_*`,
      // generated at read time) from a persisted message. Without it you cannot
      // tell a real assistant turn from a summary the SDK rendered for you.
      id: m.id,
      role: m.role,
      text: m.parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n"),
    }));
  }

  /**
   * DEBUG: the same window as `debugReadMessages`, but with every part intact.
   *
   * `debugReadMessages` renders a non-text part as `[tool-search_threads]`, which
   * tells you a tool ran and nothing about WHY it failed — the arguments the
   * model sent and the structured error it got back are exactly the evidence a
   * model-facing tool bug needs, and both live inside the part.
   */
  async debugReadMessageParts(limit = 12): Promise<Array<Record<string, unknown>>> {
    return this.messages.slice(-limit).map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts,
    }));
  }

  /**
   * DEBUG: run the exact turn-end backstop sweep `onChatResponse` runs, then
   * report what it attached and what the read-only UI callable now sees. Lets us
   * confirm headlessly whether the backstop attaches a watcher (and whether the
   * dock's data source is populated) without driving a real chat turn.
   */
  async debugRunBackstop(): Promise<{
    attached: string[];
    watchers: Array<{ processId: string; command: string; deadlineAt: number }>;
    runningProcesses: Array<{ processId: string; status: string }>;
  }> {
    const admission = await this.backgroundExecAdmitted();
    if (!admission) {
      return { attached: [], watchers: [], runningProcesses: [] };
    }
    const resolved = await resolveComputeService(this.sandboxHostDeps(admission));
    if (!resolved) return { attached: [], watchers: [], runningProcesses: [] };
    const before = await resolved.service.execList({ status: "all", limit: 50 });
    const swept = await resolved.service.autoWatchRunningProcesses();
    const watchers = await this.listActiveWatchers();
    return {
      attached: swept.attached,
      watchers: watchers.map((w) => ({
        processId: w.processId,
        command: w.command,
        deadlineAt: w.deadlineAt,
      })),
      runningProcesses: before.processes.map((p) => ({ processId: p.id, status: p.status })),
    };
  }

  /**
   * DEBUG: the thread's tool-call timings, newest start first.
   *
   * Open rows (`finishedAt: null`) are included and are the reason this exists —
   * a tool call that never returned is invisible everywhere else.
   */
  async debugToolCallTiming(): Promise<{ rows: ToolCallTimingRow[] }> {
    return { rows: this.toolCallTiming.list() };
  }

  /** DEBUG: raw Daytona command dump for a process (diagnose exit-detection). */
  async debugRawProcessStatus(processId: string): Promise<unknown> {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) return { error: "sandbox_disabled" };
    return resolved.service.debugRawProcessStatus(processId);
  }

  /**
   * This thread's subagent ledger rows, newest run first — the full HISTORY,
   * terminal rows included. For the views that genuinely want every run
   * (`listSubagentRuns`, `subagentRunTimings`, `debugSubagentState`).
   *
   * Anything that only needs the LIVE runs must use `openSubagentRows` instead:
   * the ledger has no prune, so this scan and sort grow without bound.
   */
  private subagentRows(): WorkRow[] {
    return this.workLedger
      .listAll()
      .filter((row) => row.kind === "subagent")
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The live subagent rows, newest first, over `listOpen` (filtered on
   * `terminal_outcome IS NULL`) rather than the full history. `hasBlockingWork`
   * runs on every alarm tick, `releaseIfIdle`, `releaseIfReclaimable` and
   * `execShutdown`, and answers a boolean — it must not full-scan and sort every
   * run the thread has ever made to get there.
   */
  private openSubagentRows(): WorkRow[] {
    return this.workLedger
      .listOpen()
      .filter((row) => row.kind === "subagent")
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The active-child lease set, DERIVED: an open subagent row IS a live lease.
   * A reaped run therefore releases its eviction hold with no second write to
   * forget — the drift the standalone lease set could produce is gone by
   * construction.
   */
  private openSubagentRunIds(): string[] {
    return this.openSubagentRows().map((row) => row.id);
  }

  /** Run timings, DERIVED: `startedAt`/`terminal.at` ARE the timings. */
  private subagentRunTimings(): Record<string, { startedAt: number; finishedAt?: number }> {
    return Object.fromEntries(
      this.subagentRows().map((row) => [
        row.id,
        { startedAt: row.startedAt, ...(row.terminal ? { finishedAt: row.terminal.at } : {}) },
      ]),
    );
  }

  /**
   * Enumerate this parent's subagent runs with current status + summary, for the
   * `check_subagents` tool. The run list comes from the work ledger; the
   * SDK-internal `_readAgentToolRun` (already used by the detached-completion
   * override) supplies status/label/summary. Read-only and defensive: a cleared
   * or unreadable run is skipped, and it never throws.
   */
  private async listSubagentRuns(): Promise<SubagentRunStatus[]> {
    const read = (
      this as unknown as {
        _readAgentToolRun?: (id: string) =>
          | {
              status?: string;
              summary?: string | null;
              input_preview?: string;
              display_metadata?: string;
            }
          | undefined;
      }
    )._readAgentToolRun;
    const runIds = this.subagentRows()
      .slice(0, 20)
      .map((row) => row.id);
    const runs: SubagentRunStatus[] = [];
    for (const runId of runIds) {
      const row = read?.call(this, runId);
      if (!row) continue;
      let label: string | undefined;
      try {
        const display: unknown = row.display_metadata
          ? JSON.parse(row.display_metadata)
          : undefined;
        if (
          display &&
          typeof display === "object" &&
          typeof (display as { name?: unknown }).name === "string"
        ) {
          label = (display as { name: string }).name;
        }
      } catch {
        // ignore malformed display metadata
      }
      label = label ?? unwrapStoredInputPreview(row.input_preview);
      runs.push({
        runId,
        ...(label ? { label } : {}),
        status: row.status ?? "unknown",
        ...(row.summary ? { summary: row.summary } : {}),
      });
    }
    return runs;
  }

  /**
   * The SDK calls this to format the message it would DEFER onto the parent's
   * turn queue when a detached subagent finishes (`detached.notify`). Delivery
   * has MOVED to the {@link _deliverDetachedTerminal} override, which enqueues
   * the completion into the injection buffer at prompt-detection time so a
   * mid-turn parent steers it instead of queuing behind the current turn.
   *
   * Returning `""` for every outcome suppresses the SDK's own deferred
   * submission (confirmed in `@cloudflare/think`'s `_cfDetachedNotifyFinish`:
   * empty text early-returns before `submitMessages`), which is what makes the
   * pair exactly-once — our buffer delivers, the SDK stays silent. Do NOT
   * reintroduce a real string here or every completion double-fires.
   */
  protected override formatDetachedCompletion(
    _run: AgentToolRunInfo,
    _result: AgentToolLifecycleResult,
  ): string {
    return "";
  }

  /**
   * Auth gate for facet routing: only wake/inspect a child this parent actually
   * owns. Guessed run ids get 404. (The outer authorizeAgentRequest already
   * checked workspace ownership of the parent thread.)
   */
  override async onBeforeSubAgent(
    _request: Request,
    child: { className: string; name: string },
  ): Promise<Response | void> {
    if (!this.hasSubAgent(child.className, child.name)) {
      return new Response("Not found", { status: 404 });
    }
  }

  override async destroy(): Promise<void> {
    await teardownThreadBeforeDestroy({
      threadId: this.name,
      logPrefix: "think_thread",
      cancelActiveSubagents: () => this.cancelActiveSubagentsForDestroy(),
      resolveComputeService: () => resolveComputeService(this.sandboxHostDeps()),
    });
    await super.destroy();
  }

  private async cancelActiveSubagentsForDestroy(): Promise<void> {
    const runIds = this.openSubagentRunIds();
    try {
      await Promise.all(
        runIds.map(async (runId) => {
          try {
            await this.cancelAgentTool(runId, "thread_destroy");
          } catch (error) {
            log.warn("think_thread.destroy_cancel_subagent_failed", {
              threadId: this.name,
              runId,
              error: String(error),
            });
          }
        }),
      );
    } finally {
      // Drop the rows rather than terminalize them: the DO is being destroyed,
      // so there is nobody left to notify and no horizon left to advance.
      await this.serializeLeaseMutation(async () => {
        for (const runId of runIds) this.workLedger.deleteRow(runId);
      });
    }
  }

  /**
   * (Re)arm this thread's single idle-eviction alarm. The ONE implementation:
   * `sandboxHostDeps().scheduleEviction` calls it, and so does
   * {@link scheduleSandboxEviction} on behalf of the sandbox DO. Throws on
   * failure — the in-process callers depend on that.
   */
  private armComputeEviction(timestampMs: number): Promise<void> {
    return scheduleComputeEviction(
      {
        storage: this.ctx.storage,
        schedule: (when, callback) => this.schedule(when, callback as keyof this),
        cancelSchedule: (id) => this.cancelSchedule(id),
      },
      timestampMs,
      "runSandboxEviction",
    );
  }

  /** Cancel the outstanding idle-eviction alarm. Counterpart of {@link armComputeEviction}. */
  private disarmComputeEviction(): Promise<void> {
    return cancelComputeEviction({
      storage: this.ctx.storage,
      cancelSchedule: (id) => this.cancelSchedule(id),
    });
  }

  /**
   * Deliver a hidden system-reminder into this thread. The ONE implementation
   * behind both the in-process `sandboxHostDeps().deliverSystemReminder` closure
   * and the {@link deliverSystemReminderFromSandbox} RPC.
   *
   * THROWS on failure, deliberately: the work ledger's retry path is built on
   * it (a delivery that throws skips `deleteWatcher`/`markDelivered`, leaving
   * the row owed so the next sweep retries).
   */
  private async raiseSystemReminder(
    body: string,
    mode: "deferred" | "proactive",
    options?: { watcher?: WatcherCompletionInfo },
  ): Promise<void> {
    // A watcher completion carries structured metadata so the web
    // transcript renders it as a visible card; every other reminder is the
    // plain hidden variant. Both keep the same `<system-reminder>` body, so
    // the model reads them identically.
    const message = options?.watcher
      ? buildWatcherCompletionMessage(body, options.watcher)
      : buildSystemReminderMessage(body);
    if (mode === "deferred") {
      // `addMessages` is Think's documented no-turn append primitive —
      // unlike `saveMessages` (which runs a turn), it only writes into the
      // Session tree + live cache. During beforeTurn setup, also append the
      // converted message to the in-flight model input so turn-start resume
      // and expiry notices are visible immediately.
      await this.addMessages([message]);
      this.currentTurnSetupReminders?.push(...(await convertToModelMessages([message])));
      return;
    }
    // Proactive: route through the injection buffer so a mid-turn
    // completion STEERS into the running turn's next step instead of
    // queuing behind it.
    if (options?.watcher) {
      this.deliverInjection({
        dedupeKey: `watcher:${options.watcher.processId}:${options.watcher.outcome}`,
        kind: "watcher-completion",
        message,
      });
      return;
    }
    // Non-watcher proactive reminders (none today) keep enqueuing through
    // the same queued-submission path client messages use (see
    // submitQueuedUserMessage below), so it merges with any waiting batch
    // and drains into its own turn via the SDK's submission drain loop —
    // no connected client required (see the spike note in
    // queued-user-messages.ts / task-4-report.md). The item preview is
    // built by hand rather than via normalizeQueuedUserMessageInput, since
    // that helper's `hasContent` check is tuned for real user text and the
    // preview is never shown anyway — serializeQueuedUserMessageSubmissionRows
    // strips system-reminder messages (and the watcher-completion variant)
    // from the queued strip.
    const normalized: NormalizedQueuedUserMessage = {
      message,
      item: {
        clientMessageId: message.id,
        textPreview: "",
        attachmentCount: 0,
        attachments: [],
      },
      attachmentIds: [],
    };
    await this.serializeQueuedRpc(() =>
      submitQueuedUserMessageBatch(this.queuedSubmissionPort(), normalized),
    );
  }

  /**
   * {@link SandboxThreadHost} — the back-call surface `AgentSandbox` uses. The
   * sandbox DO owns the machine; the transcript and the eviction schedule stay
   * here, so those two capabilities are reached by RPC.
   *
   * Nothing below throws: a throw over DO RPC reaches the caller as a phantom
   * rejection it cannot attribute to a call, so failures are ENCODED. The near
   * side (createSandboxThreadHostDeps) logs and swallows them.
   */
  async deliverSystemReminderFromSandbox(input: {
    body: string;
    mode: "deferred" | "proactive";
    watcher?: WatcherCompletionInfo;
  }): Promise<SandboxCallResult<null>> {
    try {
      await this.raiseSystemReminder(
        input.body,
        input.mode,
        input.watcher ? { watcher: input.watcher } : undefined,
      );
      return { ok: true, value: null };
    } catch (error) {
      log.warn("think_thread.sandbox_reminder_failed", {
        threadId: this.name,
        mode: input.mode,
        error: String(error),
      });
      return { ok: false, error: { code: "deliver_reminder_failed", message: String(error) } };
    }
  }

  /** {@link SandboxThreadHost} — arm this thread's idle-eviction alarm. */
  async scheduleSandboxEviction(input: { timestampMs: number }): Promise<SandboxCallResult<null>> {
    try {
      await this.armComputeEviction(input.timestampMs);
      return { ok: true, value: null };
    } catch (error) {
      log.warn("think_thread.sandbox_schedule_eviction_failed", {
        threadId: this.name,
        error: String(error),
      });
      return { ok: false, error: { code: "schedule_eviction_failed", message: String(error) } };
    }
  }

  /** {@link SandboxThreadHost} — cancel this thread's idle-eviction alarm. */
  async cancelSandboxEviction(): Promise<SandboxCallResult<null>> {
    try {
      await this.disarmComputeEviction();
      return { ok: true, value: null };
    } catch (error) {
      log.warn("think_thread.sandbox_cancel_eviction_failed", {
        threadId: this.name,
        error: String(error),
      });
      return { ok: false, error: { code: "cancel_eviction_failed", message: String(error) } };
    }
  }

  /**
   * Wiring the thread DO passes to the native sandbox tools and the eviction
   * callback: DO SQLite storage, the runtime config resolver, the SDK-scheduler
   * bridge for idle eviction, and the deferred system-reminder delivery hook.
   */
  private sandboxHostDeps(backgroundWorkAdmission?: boolean): ComputeToolHostDeps {
    const attachedRuntime = this.attachedRuntimeForThisAgent();
    const processMonitorEnabled = backgroundWorkAdmission ?? this.processMonitorEnabled();
    return {
      env: this.env,
      threadId: this.name,
      storage: this.ctx.storage,
      // Think can drive a proactive turn (see deliverSystemReminder below), so
      // watcher exit reminders are surfaced instead of silently dropped.
      supportsProcessMonitor: processMonitorEnabled,
      backgroundLongRunningExec: processMonitorEnabled && !attachedRuntime,
      resolveRuntimeConfig: async () => {
        const config = await this.resolveRuntimeConfigForThink();
        return { workspaceId: config.workspaceId, agentId: config.agentId };
      },
      ...(attachedRuntime ? { attachedRuntime } : {}),
      // All three delegate to the methods below, which are ALSO the RPC surface
      // `AgentSandbox` calls back on (see src/compute/sandbox-thread-host.ts).
      // One implementation, two callers — the closure is deleted once the tools
      // move into the sandbox DO.
      scheduleEviction: (timestampMs) => this.armComputeEviction(timestampMs),
      cancelEviction: () => this.disarmComputeEviction(),
      deliverSystemReminder: (body, mode, options) => this.raiseSystemReminder(body, mode, options),
      // Defer idle eviction of the shared machine while any subagent is live.
      // DERIVED from the ledger now (an open `kind: "subagent"` row IS the
      // lease), so a reaped run releases the hold with nothing to forget.
      // SubAgent inherits this harmlessly: its own storage's ledger has no
      // subagent rows (they live on the PARENT's storage), so it resolves
      // false, and releaseIfIdle no-ops in attached mode regardless.
      //
      // Scoped to SUBAGENT rows, deliberately NOT "any open row". Process rows
      // are already covered where it matters and counting them here only does
      // damage:
      //  - idle eviction: `runAlarm` returns at `countWatchers() > 0` BEFORE
      //    reaching `releaseIfIdle`, so a watched process already defers
      //    eviction; an open process row adds nothing.
      //  - `releaseIfReclaimable`: gated on running processes AND
      //    `countWatchers() > 0` first — again already covered.
      //  - `execShutdown`: this gate THROWS `compute_children_active`. It runs
      //    before the running-process `needsConfirmation` flow, so counting
      //    process rows would make that flow dead code — the model could no
      //    longer shut its own sandbox down while anything is watched, not even
      //    with `confirm: true` — and would break thread destroy, which calls
      //    `execShutdown({ confirm: true })` and would leak the container.
      // "Blocking work" here means a CHILD AGENT is on this machine (hence the
      // error's name); a background process is the owner's own work, and it has
      // its own affordances.
      // The backfill is awaited HERE, in the reader itself, rather than at some
      // seam upstream that merely happens to run first today. A subagent that
      // was in flight across the deploy has no row until it runs, so a
      // `hasBlockingWork` that answered before it would answer `false` and let
      // `releaseIfIdle` delete the shared container out from under a live child.
      // Making the reader the seam is what makes that unorderable-by-mistake.
      // It is memoized and, once the legacy keys are gone, costs one storage
      // miss per instance.
      hasBlockingWork: async () => {
        await this.ensureLegacySubagentBackfill();
        return this.openSubagentRunIds().length > 0;
      },
      markSandboxDirty: () => this.clearSandboxDeclaredClean(),
      setSandboxDeclaredClean: (clean) => this.setSandboxDeclaredClean(clean),
      isSandboxDeclaredClean: () => this.getSandboxDeclaredClean(),
      probeWorkspaceCleanliness: async () => {
        const resolved = await resolveComputeService(this.sandboxHostDeps());
        if (!resolved) return { state: "probe_failed", reason: "no_compute_service" };
        return probeWorkspaceCleanliness((command, timeoutMs) =>
          resolved.service.execRun({ command, timeoutMs, label: "workspace cleanliness" }),
        );
      },
      workLedger: this.workLedger,
      // The reaper piggybacks the compute service's single alarm: this horizon
      // is min-folded into `nextWakeAt` alongside watcher polls and the release
      // time. It must never be a SECOND arm — `scheduleComputeEviction` is
      // cancel-then-set on one stored id, so a second arm point replaces the
      // watcher poll rather than adding to it. The alarm callback's fallback
      // arm is not a second arm: it is gated on `alarmArmCount()` not moving,
      // i.e. it fires only when this min-fold never ran.
      getWorkHorizon: () => this.workHorizon(Date.now()),
      // Automatic preparation on a genuinely fresh sandbox (never a recovery
      // restore — see ThreadComputeService.readOrAcquireRuntime). It already
      // no-ops when the thread has no repository snapshots, so a
      // workbench-less thread pays nothing extra.
      onFreshRuntimeAcquired: (() => {
        const prepareRepositories = createRepositoryPreparation({
          env: this.env,
          threadId: this.name,
          resolveComputeService: () => resolveComputeService(this.sandboxHostDeps()),
        });
        return async () => {
          const result = await prepareRepositories();
          // A SKIP is not an error, so nothing throws and the `catch` around
          // this call never fires — which is exactly how a provider-contract
          // mismatch left every workbench sandbox with an empty /workspace
          // while the logs stayed clean. Skips are the interesting outcome
          // here; say so, or the next such break is invisible too.
          if (result.skipped?.length) {
            log.warn("compute.repository_preparation_skipped", {
              threadId: this.name,
              skipped: result.skipped.map((entry) => `${entry.name}: ${entry.reason}`),
            });
          }
        };
      })(),
    };
  }

  /**
   * Deps for the turn-end workbench-switch commit backstop (see
   * `onChatResponse`). Reuses `sandboxHostDeps().hasBlockingWork` — the same
   * child-subagent gate `execShutdown` itself consults — so this never invents
   * a second way to ask "is it safe to tear this sandbox down".
   */
  private workbenchSwitchCommitDeps(): WorkbenchSwitchCommitDeps {
    const hostDeps = this.sandboxHostDeps();
    return {
      threadId: this.name,
      now: () => Date.now(),
      commitWorkbenchSwitch: (threadId, at) =>
        new ThreadRepository(registryDb(this.env)).commitWorkbenchSwitch(threadId, at),
      execShutdown: async () => {
        const resolved = await resolveComputeService(hostDeps);
        if (!resolved) return { ok: true, terminated: false, alreadyGone: true };
        return resolved.service.execShutdown({ confirm: true });
      },
      hasBlockingWork: async () => (await hostDeps.hasBlockingWork?.()) === true,
      adoptCommittedResourceProfile: () => adoptCommittedWorkbenchResourceProfile(hostDeps),
      onTeardownFailure: (error) =>
        log.warn("think_thread.workbench_switch_teardown_failed", {
          threadId: this.name,
          error: String(error),
        }),
    };
  }

  /**
   * The ledger's next wake: the soonest of the open rows' sweep horizon and, if
   * anything is terminal-but-owed, one retry interval out.
   *
   * The owed arm is not an optimization — it is the only wake source the retry
   * pass has. An owed row is closed, so `listOpen()` cannot see it and
   * `nextSweepAt` contributes nothing for it; a thread whose LAST open row closed
   * and whose delivery then threw would arm no alarm, never sweep again, and owe
   * that row forever (`prune` keeps undelivered rows regardless of age). Every
   * other wake source is incidental — a watcher, another open row — and the
   * failure this exists for is precisely the one where there is no other source.
   *
   * Store reads ONLY (`listOpen` + a COUNT), like everything the classification
   * path touches: a backend call reachable from here wedges the DO on a dead
   * sandbox. `countUndelivered()` rather than `listUndelivered()` because this
   * runs on every arm and only existence is needed.
   */
  private workHorizon(now: number): number | null {
    const openHorizon = nextSweepAt(this.workLedger.listOpen());
    // Always `now + interval`, never a stored deadline: a delivery that keeps
    // throwing must re-arm a minute out each pass, not refire immediately
    // against a horizon pinned in the past.
    const retryHorizon =
      this.workLedger.countUndelivered() > 0 ? now + WORK_DELIVERY_RETRY_MS : null;
    if (openHorizon === null) return retryHorizon;
    if (retryHorizon === null) return openHorizon;
    return Math.min(openHorizon, retryHorizon);
  }

  private injectionBuffer(): InjectionBuffer {
    if (!this._injectionBuffer) {
      this._injectionBuffer = new InjectionBuffer(this.ctx.storage);
      this._injectionBuffer.migrate();
    }
    return this._injectionBuffer;
  }

  /**
   * Durable store for the background work ledger the reaper sweeps. Owns its
   * own schema (see `WorkLedgerStore`), lazily constructed on this DO's
   * storage just like `injectionBuffer()`.
   */
  private get workLedger(): WorkLedgerStore {
    if (!this.workLedgerInstance) {
      this.workLedgerInstance = new WorkLedgerStore(this.ctx.storage);
      this.workLedgerInstance.migrate();
    }
    return this.workLedgerInstance;
  }

  /**
   * Durable per-call tool timings. Same lazy-construct-and-migrate shape as
   * {@link workLedger}, and like it, owns its own schema.
   */
  private get toolCallTiming(): ToolCallTimingStore {
    if (!this.toolCallTimingInstance) {
      this.toolCallTimingInstance = new ToolCallTimingStore(this.ctx.storage);
      this.toolCallTimingInstance.migrate();
    }
    return this.toolCallTimingInstance;
  }

  /**
   * Stamp recorded durations onto a message's tool parts as it is READ.
   *
   * Applied at all three read seams — `exportHistory` (live UI),
   * `exportRawHistory` (the archive snapshot), and `getThinkTranscriptMessage`
   * (the paginated source). Stamping the archive export is what carries
   * durations into D1: an archived thread serves history from that snapshot and
   * never touches this DO again, so a value missing at archive time is missing
   * forever.
   *
   * WHY NOT AT WRITE TIME. #85 overrode Think's PROTECTED
   * `appendMessageToHistory` / `updateMessageInHistory` to stamp once on the way
   * to storage. Those overrides never ran: Think calls its own PRIVATE
   * `_appendMessageToHistory` / `_updateMessageInHistory` everywhere internally
   * (think.js:3197, 5472, 5474, 7140, …), and the protected pair is only a
   * public wrapper nothing internal goes through. The feature shipped inert.
   * Do not "simplify" this back to a single write-time hook without first
   * checking that Think actually routes through the method you are overriding.
   *
   * The cost of read-time stamping is that a duration appears when a thread's
   * history is loaded, not mid-stream on the turn that produced it — the live
   * socket message is built by the SDK and never passes through here.
   */
  private stampDurations<T>(message: T): T {
    try {
      const ids = toolCallIdsIn(message);
      if (ids.length === 0) return message;
      return stampToolCallDurations(message, this.toolCallTiming.durationsFor(ids)) as T;
    } catch (error) {
      // Timing is diagnostics. It must never be able to fail a message write.
      log.warn("think_thread.tool_timing_stamp_failed", {
        threadId: this.name,
        error: String(error),
      });
      return message;
    }
  }

  /**
   * Run {@link backfillLegacySubagentRuns} at most once per instance. Memoized
   * on the PROMISE, not on a boolean, so concurrent callers await the same pass
   * instead of racing two backfills.
   */
  private ensureLegacySubagentBackfill(): Promise<void> {
    this.legacyBackfillPromise ??= this.backfillLegacySubagentRuns();
    return this.legacyBackfillPromise;
  }

  /**
   * One-shot migration of the pre-ledger lease/timing keys into ledger rows.
   *
   * Before the ledger, a subagent's eviction hold lived in DO storage at
   * `subagent:active-runs` and SURVIVED a restart. It is now a row registered at
   * spawn — so a subagent dispatched BEFORE this deploy has no row after it:
   * `openSubagentRunIds()` -> [], `hasBlockingWork()` -> false. The child's exec
   * runs through its own attached service and never touches the parent's
   * `lastUsedAt`, so the parent goes idle and `releaseIfIdle` DESTROYS the
   * shared container out from under a live child. This backfill is what stops
   * that, and it is why both legacy keys are read rather than just dropped.
   *
   * Idempotent (any id that already has a row is skipped, and the keys are
   * deleted only after the rows land) and it NEVER throws: it runs on the alarm
   * path, where a throw on one malformed legacy value would break the reaper for
   * the whole thread. Every legacy value is treated as untrusted shape.
   *
   * Field-by-field, and each choice is load-bearing:
   *  - `startedAt`: the LEGACY value when the timing map has one, so the run
   *    keeps its real age. Falls back to `now` only when the timing map is
   *    missing/malformed — the run is then younger than it really is, which
   *    costs at most one extra budget's patience and never a false terminal.
   *  - `deadlineAt`: derived from that `startedAt`, NOT from `now`, or a
   *    pre-deploy run would silently get a fresh full budget. A run already past
   *    its budget lands with a deadline in the past and is honestly timed out on
   *    the first sweep.
   *  - `lastAliveAt`: `now`, NOT `startedAt`. We have no liveness history for a
   *    legacy run, and back-dating it would make every backfilled row instantly
   *    stale -> faulted `no_liveness` on the first sweep -> the hold released and
   *    the container destroyed, i.e. exactly the bug this exists to fix. `now`
   *    gives the child one stale window to prove itself with a heartbeat; a
   *    genuinely dead one is reaped 3 minutes later, on the evidence.
   *  - `generation`: the CURRENT nonce, the same value `spawnSubagent` stamps.
   *    A legacy run has no recorded generation and "unknown" is not a safe
   *    placeholder — it would differ from a live nonce and fault every
   *    backfilled row as `sandbox_reset` immediately, releasing the hold AND
   *    lying to the model. Stamping the current nonce can only mis-read a reset
   *    that happened before the backfill (a false negative still backstopped by
   *    `deadlineAt` and liveness), which is strictly the better failure.
   *
   *    Read via `getCurrentGeneration` (a STORE read) and deliberately NOT via
   *    `refreshGeneration`, even though this registers rows. Two reasons, both
   *    load-bearing:
   *
   *    1. WEDGE (primary). Unlike the other three registration sites, this one is
   *       reached from `hasBlockingWork` and from `runWorkLedgerSweep` — the
   *       reaper's classification path — which must stay backend-free or a call
   *       that blocks on a dead sandbox wedges the whole DO.
   *    2. DETECTION. A probe here would not merely be pointless — it would be
   *       actively harmful. If the container was wiped mid-run, probing would see
   *       the nonce absent, restore it, and stamp these rows with the RESTORED
   *       nonce — sparing rows whose files are genuinely gone. Not probing stamps
   *       the pre-wipe nonce, which is what lets the next sweep detect the reset.
   *       (What the work actually RAN on is fixed either way; what changes is what
   *       it is stamped with, and the stamp is the evidence classification reads.)
   *
   *    Pinned by "the sweep makes no backend call" in
   *    `test/integration/work-ledger.integration.test.ts`, which seeds the legacy
   *    keys so this path engages under a live container and fails if anything
   *    here reaches the backend.
   */
  private async backfillLegacySubagentRuns(): Promise<void> {
    try {
      const lease = await this.ctx.storage.get<unknown>(LEGACY_SUBAGENT_LEASE_KEY);
      const runIds = Array.isArray(lease)
        ? lease.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      if (runIds.length > 0) {
        const timings = readLegacyRunTimings(
          await this.ctx.storage.get<unknown>(LEGACY_SUBAGENT_TIMING_KEY),
        );
        // Resolved OUTSIDE serializeLeaseMutation: it is an async resolve, and
        // blockConcurrencyWhile must wrap the writes only.
        const view = await this.getCurrentGeneration();
        const generation = view.kind === "known" ? view.nonce : "unknown";
        const now = Date.now();
        await this.serializeLeaseMutation(async () => {
          for (const runId of runIds) {
            // Already migrated, or re-registered by a live spawn: either way the
            // row is the truth and this pass must not touch it.
            if (this.workLedger.get(runId)) continue;
            const timing = timings[runId];
            // A run the legacy map already finished holds nothing; materializing
            // an OPEN row for it would invent a hold that nothing will release.
            if (timing?.finishedAt !== undefined) continue;
            const startedAt = timing?.startedAt ?? now;
            this.workLedger.register({
              id: runId,
              kind: "subagent",
              startedAt,
              lastAliveAt: now,
              staleAfterMs: SUBAGENT_STALE_AFTER_MS,
              deadlineAt: startedAt + SUBAGENT_DEADLINE_MS,
              generation,
              terminal: null,
              deliveredAt: null,
            });
          }
        });
      }
      // Last, so a crash mid-backfill leaves the keys for the next attempt.
      // Unconditional: the keys are abandoned either way, and deleting them is
      // what makes this genuinely one-shot rather than a read on every alarm.
      await this.ctx.storage.delete([LEGACY_SUBAGENT_LEASE_KEY, LEGACY_SUBAGENT_TIMING_KEY]);
    } catch (error) {
      log.warn("think_thread.subagent_backfill_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
  }

  /**
   * Best-effort "is a real LLM turn running?" signal. Reads the SDK's internal
   * TurnQueue (not in public types) — coupling isolated here. Correctness does
   * NOT depend on this being exact (see routeInjection + onChatResponse flush).
   */
  private isTurnActive(): boolean {
    return (
      (this as unknown as { _turnQueue?: { isActive?: boolean } })._turnQueue?.isActive === true
    );
  }

  /** Single producer entry point for proactive/steering delivery. */
  deliverInjection(entry: { dedupeKey: string; kind: InjectionKind; message: UIMessage }): void {
    routeInjection({
      buffer: this.injectionBuffer(),
      isTurnActive: () => this.isTurnActive(),
      kick: () => void this._kickInjectionTurn(),
      now: Date.now(),
      entry,
    });
  }

  /**
   * Idle path: drain the buffer and start a turn with the messages as input.
   * Peek → submit → delete, in that order (see `_drainInjectionsIntoTurn`):
   * if `submitMessages` throws, the entries stay in the buffer (delete never
   * ran) so the next turn's drain or flush retries them instead of silently
   * stranding them.
   */
  private async _kickInjectionTurn(): Promise<void> {
    const drained = this.injectionBuffer().peekAll();
    if (drained.length === 0) return;
    await this.submitMessages(drained.map((d) => d.message)); // durable submission row FIRST
    this.injectionBuffer().deleteDrained(drained.map((d) => d.seq)); // delete AFTER
  }

  /**
   * Wiring for the native web tools: DO SQLite storage for the web-fetch
   * document store + search cache, and the workspace resolver used to read the
   * BYOK Exa key. web_fetch/web_fetch_read/web_fetch_grep are always present;
   * web_search is added only when the workspace has an exa_api_key secret.
   */
  private webHostDeps(): WebToolHostDeps {
    return {
      env: this.env,
      threadId: this.name,
      storage: this.ctx.storage,
      resolveRuntimeConfig: async () => {
        const config = await this.resolveRuntimeConfigForThink();
        return { workspaceId: config.workspaceId };
      },
    };
  }

  /**
   * Compute alarm callback, dispatched by the Agents SDK scheduler (see
   * {@link scheduleComputeEviction}). Kept under its historical name
   * (`runSandboxEviction`) since it's also the Agents SDK schedule callback
   * id, but it now runs the generalized tick (watcher polling + keep-alive +
   * idle eviction), not just plain eviction. When sandbox execution is
   * disabled the compute tick is skipped entirely (nothing is deleted), but
   * the work-ledger sweep below still runs — the ledger outlives the compute
   * service by design, since closing rows is exactly what must keep happening
   * when the sandbox is gone.
   *
   * Re-arming is the compute service's job, not this method's: the ledger's
   * horizon is min-folded into `armAlarm` via the `getWorkHorizon` dep, so one
   * alarm serves eviction, watcher polls and the sweep. This method arms only
   * as a FALLBACK, gated on the fact that nothing else armed (see below).
   *
   * ORDER IS LOAD-BEARING: resolve -> tick -> sweep -> fallback. The tick must
   * run BEFORE the sweep, and this has now been broken three times — do not
   * "optimize" it back.
   *
   * The tick polls processes and stamps `lastAliveAt`; the sweep classifies
   * rows against those stamps. Sweeping first classifies staleness from the
   * PREVIOUS tick's stamps, one line before the tick would refresh them. The
   * `PROCESS_STALE_AFTER_MS` is 3x the poll interval, so an alarm two poll
   * intervals late — or that long spent inside `resolveComputeService` (a GitHub
   * token mint plus several D1 reads) — would fault a HEALTHY, still-running
   * process as
   * `no_liveness`. The reaper must never false-positive: a false fault is worse
   * than the hang this project exists to fix.
   *
   * The accepted cost of tick-first is one spurious wake: the tick's `armAlarm`
   * folds `getWorkHorizon` over pre-sweep rows, so a row the sweep is about to
   * close can contribute a stale (possibly immediate) horizon — at most ONE
   * extra immediate wake per stale event, self-limiting because that same pass
   * closes the row and the next arm is correct. Every alternative is worse:
   * sweeping first re-opens the false-fault channel above; re-arming after the
   * sweep would CANCEL and overwrite the tick's nearer alarm (the round-3
   * Critical); clamping the horizon would hide real staleness.
   */
  async runSandboxEviction(): Promise<void> {
    // The scheduler invokes this outside a chat turn, so an unregistered thread
    // (`think_thread_not_registered:*`) or any resolution error would otherwise
    // surface as an uncaught rejection in the alarm callback. Swallow + log.
    //
    // `resolved` is threaded into the sweep below so it does not re-run
    // `resolveComputeService` (several D1 reads: agent settings, skill
    // domains, repo-env snapshot, secrets) a second time in the same tick.
    // Left `undefined` if resolution itself never completed (thread
    // unregistered, resolve threw) — the sweep then falls back to its own
    // independent resolve, isolated from whatever failed here.
    let resolved: Awaited<ReturnType<typeof resolveComputeService>> | undefined;
    // The FACT the fallback below gates on: did anything actually arm this
    // pass? Never inferred from "the tick did not throw" — a tick can throw
    // after arming (fallback would then overwrite a nearer alarm) and can
    // return without arming at all (fallback must run).
    let armed = false;
    try {
      // Attached subagents must build deps WITH attachedRuntime set, or the
      // release-if-idle attached no-op won't trip and could delete the shared
      // machine (H2). A rehydrated SubAgent instance hasn't gone through
      // beforeTurn (which primes subagentContext()), so prime it here before
      // sandboxHostDeps() reads attachedRuntimeForThisAgent().
      await this.primeAttachedContext();
      resolved = await resolveComputeService(this.sandboxHostDeps());
    } catch (error) {
      log.warn("think_thread.sandbox_eviction_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
    // Own guard: a tick failure must not skip the sweep or the fallback arm
    // below — that is the whole point of sampling `alarmArmCount`.
    if (resolved) {
      const service = resolved.service;
      const armCountBefore = service.alarmArmCount();
      try {
        await service.runComputeTick();
        // Backstop: once the environment is gone, any prior "clean" claim no
        // longer applies to it.
        if (!service.isComputeLive()) {
          await this.setSandboxDeclaredClean(false);
        }
      } catch (error) {
        log.warn("think_thread.sandbox_eviction_failed", {
          threadId: this.name,
          error: String(error),
        });
      } finally {
        armed = service.alarmArmCount() > armCountBefore;
      }
    }
    // Own guard: a sweep failure must never prevent the compute tick above from
    // having run, and must never surface as an uncaught rejection in the alarm
    // callback. Runs AFTER the tick so it classifies against fresh liveness
    // stamps — see the doc comment above; this ordering is not negotiable, and
    // the late-alarm test in alarm-rearm.test.ts fails if it is reverted.
    try {
      await this.runWorkLedgerSweep(resolved);
    } catch (error) {
      log.warn("think_thread.work_ledger_sweep_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
    // Fallback re-arm, outside every guard above. The tick's `armAlarm` is the
    // thread's one arm site and min-folds the ledger horizon, so when it armed
    // there is nothing to add: `scheduleComputeEviction` is cancel-then-set on
    // a single schedule id, so arming here would CANCEL the tick's (nearer)
    // alarm and stretch the watcher poll out to the ledger's later horizon.
    // When nothing armed — compute disabled or unresolved, the tick threw
    // (e.g. an unguarded D1 quota write), or the tick exited without arming
    // (state `acquiring`/`releasing`/`discarding` falls through `releaseIfIdle`
    // early) — nothing else will ever wake this thread, and an open row would
    // never be swept again. That is the original bug this project exists to
    // kill, so this branch is not optional.
    //
    // The horizon covers open WORK, not just open ledger rows (invariant B is
    // "never strand open work"). A live watcher whose row is already closed is
    // invisible to `listOpen()` — reachable here, since terminal-first closes
    // the row while a `deliverSystemReminder` throw skips `deleteWatcher` — so
    // fold in the watchers' next poll too, or that watcher never polls again.
    // `nextWatcherWakeAt` is a read-only store read: no backend call, so it
    // keeps the fallback's load-bearing property of never blocking on a dead
    // sandbox. `resolved` is the tick's already-completed resolution; when it is
    // absent there is no store to read and open rows alone are the best we have.
    //
    // The horizon also covers rows that are terminal-but-OWED (`workHorizon`
    // folds them in), and this is the one arm site that must: the sweep directly
    // above is what leaves a row owed — its delivery throws, the row is already
    // closed, and `listOpen()` goes empty. On a thread with no watcher and no
    // other open row that is the whole wake source, and without it the retry
    // pass can never run again.
    //
    // The ledger-row component needs no floor: the sweep above closed every
    // non-alive row in this same pass, and an `alive` row's horizon
    // (min(deadlineAt, lastAliveAt + staleAfterMs)) is by definition >= now. The
    // owed component needs none either — it is `now + WORK_DELIVERY_RETRY_MS`.
    //
    // The watcher component DOES need a floor. `nextPollAt` only advances
    // inside `pollDueWatchers`, which runs from `runComputeTick` above, AFTER
    // the unguarded `quota.refresh()` D1 write. This fallback is reached
    // precisely when that tick did NOT run to completion (it threw, e.g. that
    // D1 write failing, or exited before polling) — i.e. exactly when
    // `nextPollAt` was NOT stamped forward. Unlike a ledger row, nothing
    // closes or advances a watcher when the tick throws before polling, so a
    // `nextPollAt` already due can stay pinned in the past indefinitely,
    // re-arming the alarm hot (immediate refire, paying a full
    // `resolveComputeService` each time) for as long as the write keeps
    // failing. Only clamp when it is actually stuck in the past — a watcher
    // due soon but still ahead of `now` is a normal near-term wake and must
    // fire on schedule, not be pushed out to a full poll interval.
    if (armed) return;
    try {
      const rawWatcherHorizon = resolved?.service.nextWatcherWakeAt() ?? null;
      const now = resolved?.service.now() ?? Date.now();
      const workHorizon = this.workHorizon(now);
      const watcherHorizon =
        rawWatcherHorizon === null
          ? null
          : rawWatcherHorizon <= now
            ? now + DEFAULT_MONITOR_POLL_INTERVAL_MS
            : rawWatcherHorizon;
      const horizon =
        workHorizon === null || (watcherHorizon !== null && watcherHorizon < workHorizon)
          ? watcherHorizon
          : workHorizon;
      if (horizon !== null) await this.sandboxHostDeps().scheduleEviction(horizon);
    } catch (error) {
      log.warn("think_thread.work_ledger_rearm_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
  }

  /**
   * Build the model-facing terminal message, deliver it, and close the DELIVERY
   * gate. Delivery ONLY — no teardown — because the sweep's retry path reuses
   * this on a row whose teardown is long since decided.
   *
   * `markDelivered` lands AFTER `deliverInjection`, and the order is the whole
   * point of the split. `deliverInjection` is synchronous and durable on return
   * (it enqueues into `pending_injections`), so a throw means nothing was
   * queued: leaving `delivered_at` NULL is what lets the next sweep retry.
   * Marking first would move this method's hole rather than close it — the row
   * would read as told when it never was.
   *
   * Returns the facts the caller's teardown needs, so it is resolved once.
   */
  private async deliverWorkTerminal(input: {
    id: string;
    terminal: WorkTerminal;
    kind: WorkKind;
    lastAliveAt: number;
    resolvedService: Awaited<ReturnType<typeof resolveComputeService>> | undefined;
  }): Promise<{ service: ThreadComputeService | null }> {
    const { id, terminal, kind } = input;
    const silentMs = Math.max(0, terminal.at - input.lastAliveAt);
    const facts = await this.workFacts(id, kind, input.resolvedService);
    const body = buildFaultMessage({
      reason: terminal.reason,
      kind,
      id,
      label: facts.label,
      silentMs,
    });
    this.deliverInjection({
      dedupeKey: `${kind === "subagent" ? "subagent" : "watcher"}:${id}:${terminal.outcome}`,
      kind: kind === "subagent" ? "subagent-completion" : "watcher-completion",
      // A process terminal rides the watcher-completion variant so the
      // transcript renders it as a card (the same one a clean exit gets)
      // rather than leaking raw <system-reminder> text; the model reads the
      // identical body either way. A subagent has no such card, so it stays the
      // plain hidden reminder.
      message:
        kind === "subagent"
          ? buildSystemReminderMessage(body)
          : buildWatcherCompletionMessage(body, {
              title: facts.label,
              command: facts.command,
              processId: id,
              outcome: terminal.outcome,
              // The card needs the reason to tell a reset from a tear-down;
              // `fault` alone collapses them into one generic sentence.
              reason: terminal.reason,
              // No exit code exists: that is the whole point of a fault.
              exitCode: null,
            }),
    });
    this.workLedger.markDelivered(id, Date.now());
    return { service: facts.service };
  }

  /**
   * The single terminal funnel for work the model has NOT already been told
   * about. Returns true only for the call that actually terminalized the row —
   * a repeat sweep, or a race with the compute layer closing the row itself,
   * delivers nothing.
   *
   * Order is terminal -> deliver -> teardown, and it is not negotiable:
   *
   *  - the terminal is a local SQL write sitting behind nothing that can throw,
   *    so it always lands (a row left open re-arms the alarm hot forever);
   *  - teardown is best-effort and LAST, so a teardown failure can no longer
   *    suppress the model's only signal about work that is gone. Everything
   *    between the terminal and the delivery is guarded for the same reason:
   *    a missing label is worth an uglier message, never silence.
   *
   * The returned boolean is NOT the delivery gate — that is `markDelivered`,
   * inside `deliverWorkTerminal`. Closing the row and owning its notification
   * used to be one boolean, so a throw on the way to the model left a closed
   * row nobody would ever revisit and a model that was never told. The two are
   * split precisely so this method can fail at delivery and the sweep can retry
   * it from the stored terminal.
   *
   * `resolvedService` is the resolution the sweep already performed this tick;
   * pass nothing to resolve independently (what a direct/test caller wants).
   */
  async terminalizeWork(
    id: string,
    terminal: WorkTerminal,
    kind: WorkKind,
    resolvedService?: Awaited<ReturnType<typeof resolveComputeService>>,
  ): Promise<boolean> {
    const row = this.workLedger.get(id);
    if (!this.workLedger.terminalize(id, terminal)) return false;
    const { service } = await this.deliverWorkTerminal({
      id,
      terminal,
      kind,
      lastAliveAt: row?.lastAliveAt ?? terminal.at,
      resolvedService,
    });

    try {
      if (kind === "subagent") await this.cancelSubagentRun(id);
      // Kill only where killing is what we told the model happened. A
      // `watch_timeout` process is still running by contract ("no longer
      // watched"), and a `sandbox_reset` has no container left to kill — both
      // still lose their watcher, which is what `reapProcess` always does.
      else await service?.reapProcess(id, { kill: terminal.reason === "no_liveness" });
    } catch (error) {
      log.warn("think_thread.work_teardown_failed", {
        threadId: this.name,
        id,
        kind,
        error: String(error),
      });
    }
    return true;
  }

  /**
   * The label (and, for a process, the command) the terminal message names the
   * work by, plus the service its teardown needs. NEVER throws: this runs after
   * the terminal is written and before delivery, so any failure here must cost
   * a nice label, not the notification. Store reads only — no backend call.
   */
  private async workFacts(
    id: string,
    kind: WorkKind,
    resolvedService?: Awaited<ReturnType<typeof resolveComputeService>>,
  ): Promise<{ label: string; command: string; service: ThreadComputeService | null }> {
    if (kind === "subagent") {
      let label = id;
      try {
        label =
          unwrapStoredInputPreview(
            (
              this as unknown as {
                _readAgentToolRun?: (runId: string) => { input_preview?: string } | undefined;
              }
            )._readAgentToolRun?.(id)?.input_preview,
          ) ?? id;
      } catch {
        // An absent/changed SDK internal costs a label, never the delivery.
      }
      return { label, command: "", service: null };
    }
    try {
      const resolved =
        resolvedService !== undefined
          ? resolvedService
          : await resolveComputeService(this.sandboxHostDeps());
      const service = resolved?.service ?? null;
      const view = service?.processReapView(id) ?? null;
      return { label: view?.label ?? id, command: view?.command ?? "", service };
    } catch {
      return { label: id, command: "", service: null };
    }
  }

  /**
   * The reaper. Reads ONLY the ledger — never the backend — so it cannot
   * wedge on a dead sandbox and no error path elsewhere can prevent it from
   * running. This independence, not any individual fix, is what makes the
   * terminal invariant hold.
   *
   * The sweep DOES terminalize: a row that never closes leaves `nextSweepAt`
   * pinned at `lastAliveAt + staleAfterMs` — permanently in the past — which
   * re-arms the alarm hot forever. Closing rows is what advances the horizon.
   * It is NOT the only closer, though: work that settles cleanly is closed on
   * the spot by the compute layer (process exit/stop), so this sweep only ever
   * sees work that is genuinely still open. Without that, every healthy
   * completed process would land here as a false `no_liveness` fault.
   *
   * Dark ship applies to DELIVERY only: rows close and are logged, but nothing
   * is sent to the model and nothing is torn down. Task 6 hangs delivery off
   * the same `terminalized` funnel (populated via `terminalize`'s exactly-once
   * return), so it fires once per row and only for real transitions.
   *
   * `resolvedService`, when supplied, is the SAME resolution `runSandboxEviction`
   * already performed this tick — reuse it rather than resolving again. Pass
   * nothing (or `undefined`) to force an independent resolve, which is what
   * every direct/test caller of this method wants.
   */
  async runWorkLedgerSweep(
    resolvedService?: Awaited<ReturnType<typeof resolveComputeService>>,
  ): Promise<WorkSweepResult> {
    // Also awaited here, not only in `hasBlockingWork`: with compute disabled or
    // unresolvable that gate may never be reached, and a legacy run would then
    // be neither held nor ever reaped — invariant B ("never strand open work")
    // covers migrated rows too. Memoized, so this is the same single pass.
    await this.ensureLegacySubagentBackfill();
    const now = Date.now();
    const rows = this.workLedger.listOpen();
    // Snapshotted BEFORE the classification pass, deliberately: a row this pass
    // is about to close and deliver must not also be seen as owed. Its delivery
    // failing is next sweep's business, not this one's.
    //
    // NO reason filter, and that is load-bearing. This used to be scoped to
    // `REAPER_WORK_REASONS` on the rationale that those are the terminals this
    // funnel owns delivery for — false: `watch_timeout` is also written by
    // `pollWatcher`, for the ORDINARY case of a backgrounded process outliving
    // its watch on a healthy sandbox. That row delivered its own reminder, then
    // passed the filter, and the model read the same event twice.
    //
    // Ownership is DECLARED instead: every terminal writer stamps `delivered_at`
    // — after delivering, or immediately when it intends no delivery. So an
    // undelivered terminal now means exactly "the model was never told, and
    // someone still owes it", which needs no guessing at who wrote it.
    const owed = this.workLedger.listUndelivered();
    if (rows.length === 0 && owed.length === 0)
      return { classified: [], terminalized: [], redelivered: [] };

    // Resolve at most once for the whole sweep, and never throw out of it: an
    // unresolvable service degrades to an unknown generation (never a reset —
    // see `classifyWork`) and to id-only labels, not to a skipped sweep.
    const resolved = resolvedService !== undefined ? resolvedService : await this.resolveForSweep();
    const currentGeneration = await this.getCurrentGeneration(resolved);
    const classified: WorkSweepResult["classified"] = [];
    const terminalized: string[] = [];
    for (const row of rows) {
      const result = classifyWork({ row, currentGeneration, now });
      if (result.state === "alive") continue;
      classified.push({ id: row.id, state: result.state, reason: result.reason });
      // The funnel writes the terminal, delivers, then tears down. Its boolean
      // is the TERMINAL gate, not the delivery one — so only real transitions
      // reach `terminalized`. Being notified once per row is `markDelivered`'s
      // job (inside `deliverWorkTerminal`), which is why a delivery that throws
      // here is still owed and is retried by the pass below.
      //
      // Per-row guard: the funnel's own teardown is guarded, but delivery is
      // deliberately NOT swallowed there (silence is the bug this exists to
      // kill), so one row's failure must not strand every later row's terminal
      // and leave their horizons pinned in the past.
      let closed = false;
      try {
        closed = await this.terminalizeWork(
          row.id,
          {
            outcome: result.outcome,
            reason: result.reason,
            at: now,
            detail: `${row.kind} ${result.state}: ${result.reason}`,
          },
          row.kind,
          resolved,
        );
      } catch (error) {
        log.warn("think_thread.work_terminal_failed", {
          threadId: this.name,
          id: row.id,
          kind: row.kind,
          reason: result.reason,
          error: String(error),
        });
      }
      if (closed) terminalized.push(row.id);
      log.warn("think_thread.work_ledger_sweep", {
        threadId: this.name,
        id: row.id,
        kind: row.kind,
        state: result.state,
        reason: result.reason,
        ageMs: now - row.startedAt,
        silentMs: now - row.lastAliveAt,
        terminalized: closed,
      });
    }

    // The retry. These rows reached a terminal but the model was never told —
    // `deliverInjection` threw inside the funnel, or a `deliverSystemReminder`
    // throw on the watcher poll path left the row closed and silent. They are
    // invisible to `listOpen`, so the classification pass above can never
    // revisit them; this is the one surviving path where work reached a terminal
    // and nobody heard about it.
    //
    // Delivered from the STORED terminal, local DO-SQLite only: no backend call
    // is reachable from the sweep, ever (that is the original incident).
    //
    // Delivery only — never teardown. It already ran, or was already decided
    // against, on the pass that wrote the terminal; re-entering
    // `cancelSubagentRun`/`reapProcess` here would fire a second SDK terminal at
    // a run the reaper is done with.
    const redelivered: string[] = [];
    for (const row of owed) {
      const terminal = row.terminal;
      if (!terminal) continue;
      // A live watcher still owes this row a notification, so this retry would
      // be the SECOND copy, not the first. Reachable and not theoretical:
      // `pollWatcher` writes the terminal, then `refreshProcessOutput` re-throws
      // a transient backend error — leaving the row closed and owed with the
      // watcher still armed and its `nextPollAt` never advanced. Delivering here
      // stamps `delivered_at`, but the watcher's next poll delivers anyway (it
      // does not read `terminalize`'s return), and the buffer's dedupe key only
      // suppresses a duplicate that is STILL QUEUED — so once a turn drains the
      // first, the model reads two cards for one process.
      //
      // Yielding to the watcher is right on the merits, not just as a tiebreak:
      // its message carries the live output tail, and it is the only writer that
      // can `deleteWatcher`. The row is not stranded by the skip — the watcher's
      // `nextPollAt` arms the alarm, and if the watcher goes away without
      // delivering, the row is still owed and the next sweep (armed by
      // `workHorizon`'s owed component) finds no watcher and delivers it.
      //
      // A store read, not a backend call. `service` is null only when compute is
      // disabled or did not resolve — no `pollWatcher` can run then, so the
      // sweep is the row's only voice and must speak.
      //
      // This skip and `pollWatcher`'s `isDelivered` read (thread-service.ts,
      // above the `alreadyTold` check) are a PAIR — at-most-once for a
      // process's terminal delivery is held by the two together, not by
      // either alone. Removing this skip as "redundant now that we have the
      // delivery gate" reopens double delivery: this skip is what stops the
      // sweep from delivering out from under a watcher that still owes the
      // same row.
      if (row.kind === "process" && resolved?.service.hasWatcher(row.id)) continue;
      try {
        await this.deliverWorkTerminal({
          id: row.id,
          terminal,
          kind: row.kind,
          lastAliveAt: row.lastAliveAt,
          resolvedService: resolved,
        });
        redelivered.push(row.id);
      } catch (error) {
        // Per-row: one row's delivery failing must not strand the next row's,
        // and must never throw out of the sweep. Left undelivered, so the next
        // sweep tries again.
        log.warn("think_thread.work_delivery_retry_failed", {
          threadId: this.name,
          id: row.id,
          kind: row.kind,
          reason: terminal.reason,
          error: String(error),
        });
      }
    }
    // Retention, local DO-SQLite only: no backend call is reachable from the
    // sweep, ever — this is a plain DELETE against the stored terminal, after
    // the classification pass and the undelivered retry above so nothing this
    // tick just closed or redelivered can be pruned out from under it.
    this.workLedger.prune(now - WORK_ROW_RETENTION_MS);
    return { classified, terminalized, redelivered };
  }

  /**
   * Resolve the compute service for one sweep, degrading a failure to `null`
   * ("compute unavailable") rather than aborting the sweep. Resolution is a
   * GitHub token mint plus several D1 reads — none of it a backend touch, so
   * this keeps the reaper's never-block-on-a-dead-sandbox property.
   */
  private async resolveForSweep(): Promise<Awaited<ReturnType<typeof resolveComputeService>>> {
    try {
      return await resolveComputeService(this.sandboxHostDeps());
    } catch {
      return null;
    }
  }

  /**
   * What is known about the live sandbox's generation. `unknown` must never be
   * read as a reset (see `classifyWork`) — only a positively different nonce,
   * or a container that ANSWERED with its nonce gone, is one. Never throws: an
   * unresolvable compute service (or any resolution error) must degrade to
   * `unknown`, not break the sweep.
   *
   * A store read, deliberately: this is the sweep's path, and the reaper must
   * never make a call that can block or throw on a dead sandbox. The probe that
   * populates the store runs on the POLL path (`pollDueWatchers`'s catch).
   *
   * `resolvedService === undefined` means "resolve it now" (the default for
   * every caller except `runSandboxEviction`'s already-resolved passthrough);
   * a resolved value of `null` (compute disabled) is passed straight through
   * without re-resolving.
   */
  private async getCurrentGeneration(
    resolvedService?: Awaited<ReturnType<typeof resolveComputeService>>,
  ): Promise<CurrentGeneration> {
    try {
      const resolved =
        resolvedService !== undefined
          ? resolvedService
          : await resolveComputeService(this.sandboxHostDeps());
      return resolved?.service.getGenerationView() ?? { kind: "unknown" };
    } catch {
      return { kind: "unknown" };
    }
  }

  /**
   * Cross-DO entry point: another thread in this workspace is at its container
   * cap and is asking us to give ours up. Returns true only if we actually
   * released one. Never throws across the RPC boundary — a failure here must
   * degrade to "candidate refused", not fail the caller's turn.
   */
  async releaseIfReclaimable(): Promise<boolean> {
    try {
      // A mid-turn thread's container may hold uncommitted edits the model just
      // wrote and has not yet committed/pushed. Never give it up under a turn,
      // even though no process/watcher/subagent is running.
      if (this.isTurnActive() || this.hasActiveTurn()) return false;
      const resolved = await resolveComputeService(this.sandboxHostDeps());
      if (!resolved) return false;
      return await resolved.service.releaseIfReclaimable();
    } catch {
      return false;
    }
  }

  async providerProbeForTest() {
    const config = await this.resolveRuntimeConfigForThink();
    return {
      workspaceId: config.workspaceId,
      agentId: config.agentId,
      provider: config.modelConfig.provider,
      model: config.modelConfig.model,
    };
  }

  /**
   * Trusted context a shared-compute subagent pulls via parentAgent(). Provisions
   * the parent's environment if needed so the child always receives a LIVE
   * backend reference. Never reads model-controlled input. RPC-safe (returns a
   * structured-cloneable object).
   */
  async getSubagentContext(): Promise<SubagentContext> {
    const { workspaceId, agentId } = await this.resolveRuntimeConfigForThink();
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) throw new Error("subagent_sandbox_disabled");
    // Backend references are JSON at runtime; narrow the `unknown` payload to the
    // serializable form the RPC boundary requires.
    const attachedRuntime =
      (await resolved.service.ensureRuntimeReference()) as SerializableBackendReference;
    return { parentThreadId: this.name, workspaceId, agentId, attachedRuntime };
  }

  /**
   * Read-only view of this thread's active process watchers for the web UI.
   * Empty when sandbox execution is disabled. RPC-safe (structured-cloneable).
   */
  async listActiveWatchers(): Promise<
    Array<{
      processId: string;
      label: string | null;
      command: string;
      createdAt: number;
      deadlineAt: number;
    }>
  > {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    if (!resolved) return [];
    return resolved.service.listActiveWatchersView();
  }

  /**
   * One list for the background-work dock. Reads the LEDGER, which already
   * holds both kinds (`process` and `subagent`) with one outcome vocabulary —
   * the two views it replaces (`listActiveWatchers` / the subagent event
   * stream) each derived from a different store, which is why the UI could
   * never show a terminal outcome for a watched process.
   *
   * `label` comes from `workFacts()`, the same helper `deliverWorkTerminal`
   * uses to name a row in its notification — `WorkRow` itself carries no
   * label. Compute is resolved ONCE for the whole list and passed in, not
   * per-row: `workFacts` takes a `resolvedService` for exactly this reason.
   * Per-row, every `process` row on every 5s dock poll (per connected client)
   * paid its own `resolveComputeService` — a GitHub token mint plus several D1
   * reads. See the note at the resolve itself.
   *
   * Two fields exist only for `subagent` rows, and both are `null` on a
   * `process` row:
   *
   *  - `subagentStatus` — the SDK terminal status, without which the UI cannot
   *    tell a completed subagent from a crashed one. See
   *    {@link subagentStatusFromDetail}.
   *  - `progress` — the child's last progress signal, read from the LEDGER row
   *    the child stamps over `stampSubagentAlive`, NOT from the live event
   *    stream. That is the whole point: the stream only carries runs whose
   *    start a given client socket witnessed, so a client that reloads mid-run
   *    could never show progress for a run already in flight. This survives a
   *    reload, a second client, and DO eviction. (It is also NOT read from the
   *    SDK — see `WorkRow.progress` for why the parent cannot see the child's
   *    own `reportProgress` state.)
   *
   * Never throws — a throw inside a DO RPC method also fires an unhandled
   * rejection (see `reportProcessCompletion`'s doc). Gated on
   * `backgroundWorkAdmitted()` — the kind-agnostic gate, since this list holds
   * surface.
   */
  async listBackgroundWork(): Promise<
    Array<{
      id: string;
      kind: WorkKind;
      label: string | null;
      startedAt: number;
      progress: { message: string | null; phase: string | null; at: number } | null;
      terminal: {
        outcome: WorkOutcome;
        reason: WorkReason;
        exitCode: number | null;
        subagentStatus: SubagentTerminalStatus | null;
        at: number;
      } | null;
    }>
  > {
    const admission = await this.backgroundWorkAdmitted();
    if (!admission) return [];
    const rows = this.workLedger.listRecent();
    // Resolved ONCE for the whole list, not per row: `workFacts` accepts a
    // `resolvedService` precisely so a caller with several rows to label can
    // share one resolve. Without this, every `process` row on every 5s dock
    // poll (per connected client) paid its own `resolveComputeService` — the
    // callable this replaced (`listActiveWatchers`) was "a cheap read-only
    // callable"; this kept that name without keeping the property.
    // Caught to `null`, not left to propagate: `workFacts` treats `null` as
    // "no service" (the same as a clean disabled/not-configured resolve) and
    // falls back to the row id for the label, whereas `undefined` would make
    // it resolve independently per row — re-paying (and re-throwing on) the
    // same failure once per row instead of once for the whole list.
    const resolved = await resolveComputeService(this.sandboxHostDeps(admission)).catch(() => null);
    const out: Array<{
      id: string;
      kind: WorkKind;
      label: string | null;
      startedAt: number;
      progress: { message: string | null; phase: string | null; at: number } | null;
      terminal: {
        outcome: WorkOutcome;
        reason: WorkReason;
        exitCode: number | null;
        subagentStatus: SubagentTerminalStatus | null;
        at: number;
      } | null;
    }> = [];
    for (const row of rows) {
      let label: string | null = null;
      try {
        const facts = await this.workFacts(row.id, row.kind, resolved);
        label = facts.label;
      } catch {
        // workFacts already swallows its own failures; this is belt-and-braces
        // so a dock read can never throw across the RPC boundary.
      }
      out.push({
        id: row.id,
        kind: row.kind,
        label,
        startedAt: row.startedAt,
        progress: this.subagentProgress(row),
        terminal: row.terminal
          ? {
              outcome: row.terminal.outcome,
              reason: row.terminal.reason,
              exitCode: row.terminal.exitCode ?? parseExitCodeFromDetail(row.terminal.detail),
              subagentStatus:
                row.kind === "subagent" ? subagentStatusFromDetail(row.terminal.detail) : null,
              at: row.terminal.at,
            }
          : null,
      });
    }
    return out;
  }

  /**
   * The last progress signal a RUNNING subagent pushed, or `null` for anything
   * else. A plain read of the row the child already stamps — see
   * `WorkRow.progress` for why the parent stores this rather than asking the
   * SDK, which cannot answer from this side.
   *
   * Only for rows still open: a finished row's stale "working (step 12)" is
   * noise next to its actual outcome, and its result renders inline in the
   * transcript anyway.
   */
  private subagentProgress(row: WorkRow): WorkProgress | null {
    if (row.kind !== "subagent" || row.terminal !== null) return null;
    return row.progress ?? null;
  }

  /**
   * Head+tail output for one row in the background-work sheet — the sheet's
   * "… N lines hidden …" elision. `null` for anything that is not a watched
   * `process` row: a `subagent` id has no process output at all (returning
   * `null` there is a legitimate answer, not a failure), and so does an
   * unknown/stale id or admission being off. Never throws — see
   * `listBackgroundWork`'s doc for why a throw inside a DO RPC method is
   * doubly costly (it also fires an unhandled rejection that fails the caller
   * even when its own assertions pass).
   *
   * `stream` says which stream the slice actually came from:
   * `execOutputHeadTail` falls back to stderr when stdout is empty (a failed
   * build commonly writes its failure there, not to stdout), so the sheet
   * must not assume stdout just because that's the default request.
   */
  async readBackgroundWorkOutput(
    processId: string,
    stream?: "stdout" | "stderr",
  ): Promise<{
    head: string[];
    tail: string[];
    hiddenLines: number;
    truncated: boolean;
    stream: "stdout" | "stderr";
  } | null> {
    try {
      const admission = await this.backgroundExecAdmitted();
      if (!admission) return null;
      const row = this.workLedger.get(processId);
      if (!row || row.kind !== "process") return null;
      const resolved = await resolveComputeService(this.sandboxHostDeps(admission));
      if (!resolved) return null;
      return await resolved.service.execOutputHeadTail({ processId, stream });
    } catch {
      return null;
    }
  }

  /**
   * Cancel one row from the background-work sheet, dispatching by `kind`:
   * `cancelSubagentRun` for a subagent, `execStop` for a process — the same
   * two teardown paths `terminalizeWork` already uses for a REAPER-driven
   * close, here invoked directly for a user-driven one. Returns a result
   * object rather than throwing, same reasoning as every other work-ledger
   * RPC: a throw inside a DO RPC method also fires an unhandled rejection.
   *
   * `reason` is a CLOSED set the client switches on
   * (`"background_work_disabled" | "unknown_id" | "already_terminal" |
   * "sandbox_disabled" | "cancel_failed"`) — never raw error text. A provider
   * error from `execStop` -> `ensureRuntime` can carry sandbox ids, workspace
   * paths, or raw HTTP response text, none of which belongs on a browser
   * client; the detail goes to `log.warn` instead, same pattern as
   * `deliverWorkTerminal`'s teardown failure a few methods up.
   *
   * The subagent branch returns `{ok:true}` once `cancelSubagentRun` resolves
   * without throwing, but `cancelAgentTool` is DOCUMENTED to no-op silently
   * for a run id the SDK's own store has already forgotten — so `ok:true`
   * here means "the cancel call completed", not "a live run was actually
   * torn down". That gap is accepted: distinguishing the two would mean
   * reading SDK-internal run state (`_readAgentToolRun`, the same escape
   * hatch `workFacts` uses for a label) from a path that otherwise never
   * touches it, for a case — an open ledger row whose SDK run has vanished
   * out from under it — that should not occur while the row itself is
   * un-terminal.
   */
  async cancelBackgroundWork(id: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const admission = await this.backgroundWorkAdmitted();
      if (!admission) return { ok: false, reason: "background_work_disabled" };
      const row = this.workLedger.get(id);
      if (!row) return { ok: false, reason: "unknown_id" };
      if (row.terminal) return { ok: false, reason: "already_terminal" };
      if (row.kind === "subagent") {
        // The sheet's stop button is a HUMAN ending the work — the one
        // attribution the model must not read as "something went wrong".
        await this.cancelSubagentRun(id, "user");
        return { ok: true };
      }
      const resolved = await resolveComputeService(this.sandboxHostDeps(admission));
      if (!resolved) return { ok: false, reason: "sandbox_disabled" };
      await resolved.service.execStop({ processId: id });
      return { ok: true };
    } catch (error) {
      log.warn("think_thread.cancel_background_work_failed", {
        threadId: this.name,
        id,
        error: String(error),
      });
      return { ok: false, reason: "cancel_failed" };
    }
  }

  /**
   * "Clear finished" for the sheet. Delegates straight to
   * `WorkLedgerStore.clearFinished` — see that method's doc for why this
   * marks rows rather than deleting them: `WORK_ROW_RETENTION_MS` is a
   * correctness floor, and deleting on "clear" would reintroduce the exact
   * false `no_liveness` fault it exists to prevent (a pruned id, re-registered
   * later, comes back as a fresh open row).
   */
  async clearFinishedBackgroundWork(): Promise<{ cleared: number }> {
    try {
      const admission = await this.backgroundWorkAdmitted();
      if (!admission) return { cleared: 0 };
      return { cleared: this.workLedger.clearFinished(Date.now()) };
    } catch {
      return { cleared: 0 };
    }
  }

  /**
   * Push completion from a sandbox wrapper (the HTTP half lives in
   * `completion-routes.ts`). Idempotent on the ledger row, NOT on the token:
   * `verifyCompletionToken` is stateless and replayable until `exp`, so
   * at-most-once delivery is enforced here, by the row going terminal exactly
   * once (`workLedger.terminalize`'s exactly-once return) rather than by a
   * nonce store.
   *
   * Never throws — a throw inside a DO RPC method also fires an unhandled
   * rejection, which fails the caller even when its own assertions pass. Every
   * failure path returns a result object instead.
   *
   * Deliberately does NOT bypass `backgroundExecAdmitted()`: a
   * workspace that turned background work off mid-flight should stop being
   * told about it, same as every other work-ledger writer.
   */
  async reportProcessCompletion(input: {
    processId: string;
    exitCode: number;
  }): Promise<{ accepted: boolean; reason?: string }> {
    try {
      if (!(await this.backgroundExecAdmitted())) {
        return { accepted: false, reason: "background_work_disabled" };
      }
      const row = this.workLedger.get(input.processId);
      if (!row || row.kind !== "process") {
        return { accepted: false, reason: "unknown_process" };
      }
      if (row.terminal !== null) {
        // Replay, or a race with the poll path closing the same row first.
        // Collapse to a no-op rather than deliver a second card.
        return { accepted: true, reason: "already_terminal" };
      }

      // Resolved BEFORE `terminalize`, and that ordering is the whole point:
      // `workFacts` is a full `resolveComputeService` (a GitHub token mint plus
      // several D1 reads) and this path ALWAYS races a live watcher by
      // construction. With the resolve after the terminalize, a `pollWatcher`
      // landing in the gap saw `closed === false` and `isDelivered() === false`
      // — closed but not yet claimed — and delivered a SECOND card for the same
      // process; the injection buffer's dedupe key only suppresses an entry
      // that is still pending. The sweep avoids the identical race with its
      // `hasWatcher` skip; the push path has no analogue, so it closes the
      // window by leaving no `await` at all between terminalize, deliver and
      // stamp. Do not move this back down.
      const facts = await this.workFacts(input.processId, "process");

      const now = Date.now();
      // "exited" regardless of the code: a non-zero status is still a clean
      // exit, and `WorkOutcome` has no "failed" member. The code itself is
      // what the model reads, and it rides in the message body below.
      const outcome: WorkOutcome = "exited";
      const terminal: WorkTerminal = {
        outcome,
        reason: "process_exit",
        at: now,
        detail: `exit code ${input.exitCode}`,
        exitCode: input.exitCode,
      };
      if (!this.workLedger.terminalize(input.processId, terminal)) {
        // Lost a race with another writer (e.g. the backstop poll) that
        // terminalized this row between our `get` and now.
        return { accepted: true, reason: "already_terminal" };
      }

      // The SAME funnel the poll path uses (`pollWatcher` in
      // thread-service.ts): `deliverInjection`'s dedupe key is
      // `watcher:<processId>:<outcome>`, so a callback racing the backstop
      // collapses onto the same queued entry instead of appending a second
      // one, and a mid-turn arrival still STEERS into the running turn's next
      // step rather than queuing behind it.
      //
      // `facts` was resolved above the `terminalize` deliberately — see there.
      this.deliverInjection({
        dedupeKey: `watcher:${input.processId}:${outcome}`,
        kind: "watcher-completion",
        message: buildWatcherCompletionMessage(
          `Background process ${facts.label} (${facts.command}) exited with code ${input.exitCode}.`,
          {
            title: facts.label,
            command: facts.command,
            processId: input.processId,
            outcome,
            reason: "process_exit",
            exitCode: input.exitCode,
          },
        ),
      });
      // Ownership is DECLARED by stamping `delivered_at`, never inferred from
      // `reason` — that conflation previously caused a re-delivered reminder.
      this.workLedger.markDelivered(input.processId, now);

      // Teardown LAST and best-effort, same as `terminalizeWork`: the ledger
      // terminal and the model notification are both already durable, so a
      // failure here must cost stale compute-layer bookkeeping, never the
      // notification. Without this, the compute store keeps reporting the
      // process as running/watched (`execOutput`, `exec_watch_list`, the
      // background-work dock) even though the model was just told it exited.
      try {
        await facts.service?.recordPushedExit(input.processId, input.exitCode);
      } catch (error) {
        log.warn("think_thread.report_process_completion_teardown_failed", {
          threadId: this.name,
          processId: input.processId,
          error: String(error),
        });
      }
      return { accepted: true };
    } catch (error) {
      log.warn("think_thread.report_process_completion_failed", {
        threadId: this.name,
        processId: input.processId,
        error: String(error),
      });
      return { accepted: false, reason: "internal_error" };
    }
  }

  toolProbeForTest() {
    return Object.keys({ ...this.getTools(), ...this._testToolOverride }).sort();
  }

  /** @internal for tests only — exposes the protected process-monitor gate (true on
   *  ThinkThreadAgent, overridden to false on SubAgent). */
  processMonitorEnabledForTest(): boolean {
    return this.processMonitorEnabled();
  }

  /** @internal for tests only — the companion to
   *  {@link processMonitorEnabledForTest}. Both exist so a test can prove the two
   *  IN-TURN gates read DIFFERENT capability fields; the out-of-turn admission
   *  path is a separate seam (`backgroundCapabilitiesForTest`) and covering only
   *  that one leaves this pair free to collapse back onto a single flag. */
  subagentSpawnEnabledForTest(): boolean {
    return this.subagentSpawnEnabled();
  }

  /** @internal for tests only — exposes the protected session role context
   *  (null on ThinkThreadAgent, the subagent notice on SubAgent). */
  sessionRoleContextForTest(): { name: string; text: string } | null {
    return this.sessionRoleContext();
  }

  async skillProbeForTest() {
    const sources = await this.getSkills();
    const catalog = (await Promise.all(sources.map((source) => source.list()))).flat();
    const builtIn = await sources[0]?.load("skill_authoring");
    const deployment = await sources[1]?.load("deployment");
    return {
      sourceIds: sources.map((source) => source.id),
      catalog,
      skillAuthoringBody: builtIn?.body,
      deploymentBody: deployment?.body,
    };
  }

  beforeTurnToolNamesForTest() {
    return this._lastBeforeTurnToolNamesForTest ?? [];
  }

  beforeTurnActiveToolsForTest() {
    return this._lastBeforeTurnActiveToolsForTest ?? [];
  }

  telemetryEnabledForTest(): boolean | undefined {
    return this.currentTurnTelemetryEnabled;
  }

  /** @internal for tests only — resolves the same sandbox service used by model-facing exec tools. */
  async resolveComputeServiceForTest() {
    const admission = await this.backgroundExecAdmitted();
    return resolveComputeService(this.sandboxHostDeps(admission));
  }

  /** @internal for tests only — exposes the same fresh/pinned capabilities the
   *  direct RPCs gate on. Returns BOTH, so a test can prove they resolve
   *  independently rather than only that "something" is enabled. */
  async backgroundCapabilitiesForTest(): Promise<BackgroundCapabilities> {
    return this.backgroundCapabilities();
  }

  /** @internal for tests only — exposes buffered watcher completions before beforeStep drains them. */
  watcherCompletionsForTest() {
    return this.injectionBuffer()
      .peekAll()
      .filter((entry) => entry.kind === "watcher-completion")
      .map((entry) => entry.message);
  }

  async beforeTurnProbeForTest(messages: ModelMessage[] = []) {
    const turn = await this.beforeTurn({
      system: this.getSystemPrompt(),
      messages,
      tools: { ...this.getTools(), ...this._testToolOverride },
      model: this.getModel(),
      continuation: false,
    });
    // beforeTurn hands the naming call to waitUntil, so a test that just awaits
    // the probe would race it. Await the real promise instead of polling.
    await this._autoNameForTest;
    const model = turn?.model as { modelId?: string; provider?: string } | undefined;
    return {
      modelId: model?.modelId,
      provider: this.currentTurnTrace?.provider ?? model?.provider,
      system: turn?.system,
      activeTools: turn?.activeTools,
      providerOptions: turn?.providerOptions,
      maxSteps: turn?.maxSteps,
      messageText: (turn?.messages ?? []).map((message) => modelMessageText(message)).join("\n"),
    };
  }

  /** @internal for tests only — exposes Think's ModelMessage attachment transform. */
  async prepareModelMessagesForThinkForTest(
    messages: ModelMessage[],
    cfg: { inputModalities?: string[]; modelInputModalities?: string[] },
  ): Promise<ModelMessage[]> {
    return this.prepareModelMessagesForThink(messages, cfg);
  }

  // The queue holds at most one waiting submission carrying every waiting
  // message (see queued-user-messages.ts) — merging cancels + resubmits, so
  // concurrent queue RPCs (two tabs, rapid sends) could interleave at await
  // points and break that invariant. This chain serializes them per instance.
  private queuedRpcChain: Promise<unknown> = Promise.resolve();

  private serializeQueuedRpc<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queuedRpcChain.then(run, run);
    this.queuedRpcChain = result.catch(() => {});
    return result;
  }

  private queuedSubmissionPort(): QueuedSubmissionPort {
    return {
      listSubmissions: (options) => this.listSubmissions(options),
      inspectSubmission: (submissionId) => this.inspectSubmission(submissionId),
      cancelSubmission: (submissionId, reason) => this.cancelSubmission(submissionId, reason),
      submitMessages: (messages, options) =>
        this.submitMessages(messages, { metadata: options.metadata }),
      // Synchronous over in-memory history: the orchestration re-checks this
      // directly before cancelSubmission with no await in between, so a
      // waiting batch cannot become the active turn mid-cancel.
      appliedMessageIds: () => new Set(this.messages.map((message) => message.id)),
    };
  }

  /**
   * Drive an automaton run's turn. The prompt enters history as an ordinary
   * visible user message — an automaton thread should read honestly, so the
   * user can see what was asked and follow up in place. Deliberately NOT a
   * hidden <system-reminder>.
   *
   * Returns as soon as the submission row is durable; the SDK drain loop runs
   * the turn with no connected client, so the cron tick never awaits inference.
   */
  async beginAutomatonRun(prompt: string): Promise<void> {
    return runAutomatonTurn(
      {
        assertThreadWritable: () => this.assertThreadWritable(),
        submitMessages: (messages) => this.submitMessages(messages),
        serializeQueuedRpc: (run) => this.serializeQueuedRpc(run),
      },
      prompt,
    );
  }

  async submitQueuedUserMessage(input: unknown) {
    await this.assertThreadWritable();
    // Whatever switch the client asserted rides on the message's own
    // `metadata` — `normalizeQueuedUserMessageInput` reads it straight off
    // there onto the item (see `queued-user-messages.ts`). Per-item storage
    // is what makes cancelling a queued message carry its switch away for
    // free; a message queued with no switch asserted carries none.
    const normalized = normalizeQueuedUserMessageInput(input);
    return this.serializeQueuedRpc(async () => {
      await submitQueuedUserMessageBatch(this.queuedSubmissionPort(), normalized);
      if (normalized.attachmentIds.length > 0) {
        await new AttachmentRepository(registryBinding(this.env)).markCommitted(
          normalized.attachmentIds,
          this.name,
        );
      }
      return this.listQueuedUserMessages();
    });
  }

  async submitFeedbackUserMessage(input: {
    message: UIMessage;
    now?: number;
  }): Promise<FeedbackRateDecision> {
    await this.assertThreadWritable();
    const config = await this.resolveRuntimeConfigForThink();
    if (config.kind !== "feedback") throw new Error("feedback_thread_required");
    const normalized = normalizeQueuedUserMessageInput(input);
    if (await this.isFeedbackMessageSubmitted(normalized.message.id)) {
      return { ok: true };
    }
    const decision = await reserveFeedbackSlot(this.ctx.storage, {
      kind: "model_turn",
      key: normalized.message.id,
      now: input.now ?? Date.now(),
    });
    if (!decision.ok) return decision;
    const active = await this.ensureFeedbackInterviewForUserMessage(normalized.message.id);
    await this.serializeQueuedRpc(async () => {
      await submitQueuedUserMessageBatch(this.queuedSubmissionPort(), normalized, {
        nadiKind: "feedback-interview",
        interviewId: active.interviewId,
      });
      if (normalized.attachmentIds.length > 0) {
        await new AttachmentRepository(registryBinding(this.env)).markCommitted(
          normalized.attachmentIds,
          this.name,
        );
      }
    });
    return decision;
  }

  private async isFeedbackMessageSubmitted(messageId: string): Promise<boolean> {
    if (this.messages.some((message) => message.id === messageId)) return true;
    if (await this.isFeedbackMessageDispatched(messageId)) return true;
    const queued = await this.listQueuedUserMessages();
    return queued.some((message) => message.clientMessageId === messageId);
  }

  async listQueuedUserMessages() {
    const submissions = await this.listSubmissions({ limit: 50 });
    return submissions.flatMap((submission) =>
      serializeQueuedUserMessageSubmissionRows(submission),
    );
  }

  async cancelQueuedUserMessage(submissionId: string, clientMessageId: string) {
    await this.assertThreadWritable();
    if (typeof submissionId !== "string" || submissionId.length === 0) {
      throw new Error("queued_message_submission_id_required");
    }
    if (typeof clientMessageId !== "string" || clientMessageId.length === 0) {
      throw new Error("queued_message_client_message_id_required");
    }
    return this.serializeQueuedRpc(async () => {
      await cancelQueuedUserMessageFromBatch(
        this.queuedSubmissionPort(),
        submissionId,
        clientMessageId,
      );
      return this.listQueuedUserMessages();
    });
  }

  async startFeedbackInterviewForTest(input: {
    interviewId: string;
    fromMessageId: string;
  }): Promise<void> {
    await this.startFeedbackInterview(input);
  }

  private async startFeedbackInterview(input: {
    interviewId: string;
    fromMessageId: string;
  }): Promise<FeedbackActiveInterview> {
    if (!input.interviewId) throw new Error("feedback_interview_id_required");
    if (!input.fromMessageId) throw new Error("feedback_interview_from_message_id_required");
    const active = {
      interviewId: input.interviewId,
      fromMessageId: input.fromMessageId,
    };
    await this.ctx.storage.put(FEEDBACK_ACTIVE_INTERVIEW_STORAGE_KEY, active);
    return active;
  }

  private async getFeedbackInterviewBounds(): Promise<Record<string, FeedbackInterviewBounds>> {
    return (
      (await this.ctx.storage.get<Record<string, FeedbackInterviewBounds>>(
        FEEDBACK_INTERVIEW_BOUNDS_STORAGE_KEY,
      )) ?? {}
    );
  }

  private async recordFeedbackInterviewBounds(bounds: FeedbackInterviewBounds): Promise<void> {
    const allBounds = await this.getFeedbackInterviewBounds();
    allBounds[bounds.interviewId] = bounds;
    await this.ctx.storage.put(FEEDBACK_INTERVIEW_BOUNDS_STORAGE_KEY, allBounds);
  }

  private async getStoredFeedbackInterviewBounds(
    interviewId: string,
  ): Promise<FeedbackInterviewBounds | null> {
    return (await this.getFeedbackInterviewBounds())[interviewId] ?? null;
  }

  private async getActiveFeedbackInterview(): Promise<FeedbackActiveInterview | null> {
    return (
      (await this.ctx.storage.get<FeedbackActiveInterview>(
        FEEDBACK_ACTIVE_INTERVIEW_STORAGE_KEY,
      )) ?? null
    );
  }

  private async ensureFeedbackInterviewForUserMessage(
    fromMessageId: string,
  ): Promise<FeedbackActiveInterview> {
    const active = await this.getActiveFeedbackInterview();
    if (active) return active;
    return this.startFeedbackInterview({
      interviewId: `feedback_${crypto.randomUUID()}`,
      fromMessageId,
    });
  }

  private async feedbackDispatchedMessageIds(): Promise<string[]> {
    return (
      (await this.ctx.storage.get<string[]>(FEEDBACK_DISPATCHED_MESSAGE_IDS_STORAGE_KEY)) ?? []
    );
  }

  private async isFeedbackMessageDispatched(messageId: string): Promise<boolean> {
    return (await this.feedbackDispatchedMessageIds()).includes(messageId);
  }

  private async markFeedbackMessagesDispatched(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const seen = new Set(await this.feedbackDispatchedMessageIds());
    for (const messageId of messageIds) seen.add(messageId);
    await this.ctx.storage.put(FEEDBACK_DISPATCHED_MESSAGE_IDS_STORAGE_KEY, [...seen].slice(-120));
  }

  private async currentFeedbackInterviewMessages(
    messages: ModelMessage[],
    tools: ToolSet,
  ): Promise<ModelMessage[]> {
    const active = await this.getActiveFeedbackInterview();
    if (!active) return messages;
    const fromModelMessages = selectCurrentFeedbackInterview(messages, active.fromMessageId);
    if (fromModelMessages.length > 0) return fromModelMessages;
    const start = this.messages.findIndex((message) => message.id === active.fromMessageId);
    if (start < 0) return [];
    return convertToModelMessages(this.messages.slice(start), {
      tools,
      ignoreIncompleteToolCalls: true,
    });
  }

  async prepareFeedbackDraft(input: FeedbackDraftInput): Promise<FeedbackDraftView> {
    const active = await this.getActiveFeedbackInterview();
    if (!active) throw new Error("feedback_active_interview_required");
    const parsed = feedbackReportFieldsSchema
      .extend({
        attachmentIds: z.array(z.string().min(1)).max(5),
      })
      .parse(input);
    await this.assertFeedbackAttachmentsBelongToThread(parsed.attachmentIds);
    const toMessageId = await this.latestPersistedMessageId();
    if (!toMessageId) throw new Error("feedback_draft_message_boundary_required");
    const draft: FeedbackDraftStorage = {
      id: crypto.randomUUID(),
      interviewId: active.interviewId,
      fields: {
        category: parsed.category,
        title: parsed.title,
        narrative: parsed.narrative,
        reproductionSteps: parsed.reproductionSteps,
        expectedBehavior: parsed.expectedBehavior,
        actualBehavior: parsed.actualBehavior,
        frequency: parsed.frequency,
        impact: parsed.impact,
      },
      attachmentIds: parsed.attachmentIds,
      createdAt: Date.now(),
      fromMessageId: active.fromMessageId,
      toMessageId,
    };
    await this.ctx.storage.put(FEEDBACK_DRAFT_STORAGE_KEY, draft);
    await this.recordFeedbackInterviewBounds({
      interviewId: draft.interviewId,
      fromMessageId: draft.fromMessageId,
      toMessageId: draft.toMessageId,
    });
    return feedbackDraftView(draft);
  }

  async createManualFeedbackDraft(input: {
    interviewId: string;
    fromMessageId: string;
    fields: FeedbackReportFields;
    attachmentIds: string[];
  }): Promise<FeedbackDraftView> {
    const active = await this.startFeedbackInterview({
      interviewId: input.interviewId,
      fromMessageId: input.fromMessageId,
    });
    const parsed = feedbackReportFieldsSchema.parse(input.fields);
    const attachmentIds = z.array(z.string().min(1)).max(5).parse(input.attachmentIds);
    await this.assertFeedbackAttachmentsBelongToThread(attachmentIds);
    const draft: FeedbackDraftStorage = {
      id: crypto.randomUUID(),
      interviewId: active.interviewId,
      fields: parsed,
      attachmentIds,
      createdAt: Date.now(),
      fromMessageId: active.fromMessageId,
      toMessageId: (await this.latestPersistedMessageId()) ?? active.fromMessageId,
    };
    await this.ctx.storage.put(FEEDBACK_DRAFT_STORAGE_KEY, draft);
    await this.recordFeedbackInterviewBounds({
      interviewId: draft.interviewId,
      fromMessageId: draft.fromMessageId,
      toMessageId: draft.toMessageId,
    });
    return feedbackDraftView(draft);
  }

  async submitFeedbackDraft(input: {
    draftId: string;
    idempotencyKey: string;
    diagnostics: FeedbackDiagnostics;
    now?: number;
  }): Promise<SubmitFeedbackDraftResult> {
    await this.assertThreadWritable();
    const config = await this.resolveRuntimeConfigForThink();
    if (config.kind !== "feedback") throw new Error("feedback_thread_required");
    if (typeof input.draftId !== "string" || input.draftId.length === 0) {
      return { ok: false, reason: "stale_draft" };
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
      throw new Error("feedback_idempotency_key_required");
    }

    const idempotencyKey = input.idempotencyKey.trim();
    const diagnostics = feedbackDiagnosticsSchema.parse(input.diagnostics);
    const repo = new FeedbackRepository(registryDb(this.env));
    const existing = await repo.getReportByIdempotencyKey({
      threadId: this.name,
      idempotencyKey,
    });
    if (existing) {
      await this.appendFeedbackSubmissionAcknowledgement(existing);
      await this.ctx.storage.delete(FEEDBACK_DRAFT_STORAGE_KEY);
      await this.ctx.storage.delete(FEEDBACK_ACTIVE_INTERVIEW_STORAGE_KEY);
      return { ok: true, created: false, report: existing };
    }

    const draft =
      (await this.ctx.storage.get<FeedbackDraftStorage>(FEEDBACK_DRAFT_STORAGE_KEY)) ?? null;
    if (!draft || draft.id !== input.draftId) return { ok: false, reason: "stale_draft" };
    if (draft.attachmentIds.length > 5) throw new Error("feedback_attachment_count_invalid");
    await this.assertFeedbackScreenshotsBelongToThread(draft.attachmentIds);

    const reporter = await repo.getThreadByThreadId(this.name);
    if (!reporter || reporter.workspaceId !== config.workspaceId) {
      throw new Error("feedback_thread_owner_missing");
    }

    const now = input.now ?? Date.now();
    const decision = await reserveFeedbackSlot(this.ctx.storage, {
      kind: "report_submission",
      key: idempotencyKey,
      now,
    });
    if (!decision.ok) {
      return { ok: false, reason: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds };
    }

    const reportId = `fbr_${crypto.randomUUID()}`;
    let report: FeedbackReportDetail;
    try {
      report = await repo.createReport({
        id: reportId,
        reporterUserId: reporter.userId,
        workspaceId: reporter.workspaceId,
        threadId: this.name,
        interviewId: draft.interviewId,
        fromMessageId: draft.fromMessageId,
        toMessageId: draft.toMessageId,
        idempotencyKey,
        fields: draft.fields,
        diagnostics,
        attachmentIds: draft.attachmentIds,
        submittedAt: now,
      });
    } catch (error) {
      if (String(error).includes("feedback_report_idempotency_collision")) {
        return { ok: false, reason: "idempotency_collision" };
      }
      throw error;
    }
    await this.appendFeedbackSubmissionAcknowledgement(report);
    await this.ctx.storage.delete(FEEDBACK_DRAFT_STORAGE_KEY);
    await this.ctx.storage.delete(FEEDBACK_ACTIVE_INTERVIEW_STORAGE_KEY);
    return { ok: true, created: report.id === reportId, report };
  }

  private async appendFeedbackSubmissionAcknowledgement(
    report: Pick<FeedbackReportDetail, "id">,
  ): Promise<void> {
    const messageId = `feedback_submission_ack_${report.id}`;
    if (this.messages.some((message) => message.id === messageId)) return;
    await this.addMessages([
      {
        id: messageId,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Feedback sent to the Nadi team. I've cleared the context for this feedback thread, so your next message starts a fresh report.",
          },
        ],
      },
    ]);
  }

  async exportSubmittedFeedbackInterview(input: {
    interviewId: string;
    fromMessageId: string;
    toMessageId: string;
  }): Promise<unknown[]> {
    if (!input.interviewId) throw new Error("feedback_interview_id_required");
    if (!input.fromMessageId) throw new Error("feedback_interview_from_message_id_required");
    if (!input.toMessageId) throw new Error("feedback_interview_to_message_id_required");
    const stats = (await this.session.getHistoryRowStats()) ?? [];
    const fromIndex = stats.findIndex((row) => row.id === input.fromMessageId);
    const toIndex = stats.findIndex((row) => row.id === input.toMessageId);
    if (fromIndex < 0 || toIndex < 0) throw new Error("feedback_interview_bounds_missing");
    if (fromIndex > toIndex) throw new Error("feedback_interview_bounds_reversed");
    const storedBounds = await this.getStoredFeedbackInterviewBounds(input.interviewId);
    if (!storedBounds) throw new Error("feedback_interview_bounds_missing");
    if (
      storedBounds.fromMessageId !== input.fromMessageId ||
      storedBounds.toMessageId !== input.toMessageId
    ) {
      throw new Error("feedback_interview_bounds_mismatch");
    }
    const messages: unknown[] = [];
    for (const row of stats.slice(fromIndex, toIndex + 1)) {
      const message = await this.session.getMessage(row.id);
      if (!message) throw new Error(`feedback_interview_missing_message:${row.id}`);
      messages.push(message);
    }
    return messages;
  }

  private async latestPersistedMessageId(): Promise<string | null> {
    const session = this.session as
      | { getHistoryRowStats?: () => Promise<Array<{ id: string }> | null> }
      | undefined;
    const stats = (await session?.getHistoryRowStats?.()) ?? [];
    return stats.at(-1)?.id ?? null;
  }

  private async assertFeedbackAttachmentsBelongToThread(attachmentIds: string[]): Promise<void> {
    const repo = new AttachmentRepository(registryBinding(this.env));
    for (const attachmentId of attachmentIds) {
      const row = await repo.getByIdInThread(attachmentId, this.name);
      if (!row) throw new Error("feedback_attachment_not_found");
    }
  }

  private async assertFeedbackScreenshotsBelongToThread(attachmentIds: string[]): Promise<void> {
    const repo = new AttachmentRepository(registryBinding(this.env));
    for (const attachmentId of attachmentIds) {
      const row = await repo.getByIdInThread(attachmentId, this.name);
      if (!row || !row.mimeType.startsWith("image/")) {
        throw new Error("feedback_attachment_not_found");
      }
    }
  }

  // ── Steering: inject a user interjection into the RUNNING turn ──
  // Reuses the injection primitive (see the mid-turn-steering-injection design):
  // `steer` is a live `user-message` producer; cancel/list read the same buffer
  // the beforeStep drain empties. Distinct from queued messages, which run AFTER
  // the turn. When idle, deliverInjection kicks a fresh turn (a normal send).

  /**
   * Resolves the thread's compute service the same way model-facing exec
   * tools do (`resolveComputeService(this.sandboxHostDeps())`) and reports
   * whether a sandbox is actually live. `resolveComputeService` needs this
   * DO's own storage, so this is exposed as an RPC for `thread-routes.ts`'s
   * PATCH handler rather than resolved from the Worker directly.
   */
  async isComputeLive(): Promise<boolean> {
    const resolved = await resolveComputeService(this.sandboxHostDeps());
    // Widened deliberately: a sandbox still `acquiring` must defer the switch,
    // or it comes up cloned from the OLD workbench with no marker to fix it.
    return resolved?.service.isComputeLiveOrAcquiring() ?? false;
  }

  /**
   * Asks the agent to save its work before a live sandbox is torn down for a
   * workbench switch. Delivered through the injection buffer, not appended
   * directly: `deliverInjection` routes it into the running turn's `beforeStep`
   * drain when a turn is active, or kicks a fresh turn when idle — no branching
   * needed here. The commit side (the `confirm_workbench_switch` tool and the
   * turn-end backstop) lands in a later task.
   */
  async requestWorkbenchSwitch(workbenchName: string, workbenchId?: string | null): Promise<void> {
    this.deliverInjection({
      // Keyed on the TARGET workbench, not just the thread: a per-thread
      // constant made a second switch while one was pending a silent no-op in
      // `InjectionBuffer.enqueue`, so the agent was told to save its work for
      // workbench A while `threadIndex.workbenchId` already said B.
      dedupeKey: `workbench-switch:${this.name}:${workbenchId ?? "none"}`,
      kind: "workbench-switch",
      message: buildWorkbenchSwitchMessage(workbenchName),
    });
  }

  async steer(text: unknown, clientMessageId: unknown): Promise<string[]> {
    await this.assertThreadWritable();
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("steer_text_required");
    }
    if (typeof clientMessageId !== "string" || clientMessageId.length === 0) {
      throw new Error("steer_client_message_id_required");
    }
    this.deliverInjection({
      dedupeKey: clientMessageId,
      kind: "user-message",
      message: buildSteeredUserMessage(text, clientMessageId),
    });
    return this.pendingSteerKeys();
  }

  /**
   * Server-authoritative cancel: succeeds only while the entry is still buffered
   * (not yet drained into a step). The single-threaded DO makes this raceless, so
   * the client never has to guess — a `false` result means the agent already has
   * it. On success the caller restores the composer text.
   */
  async cancelSteer(
    clientMessageId: unknown,
  ): Promise<{ cancelled: boolean; restoredText?: string }> {
    await this.assertThreadWritable();
    if (typeof clientMessageId !== "string" || clientMessageId.length === 0) {
      throw new Error("steer_client_message_id_required");
    }
    const removed = this.injectionBuffer().remove(clientMessageId, "user-message");
    if (!removed) return { cancelled: false };
    return { cancelled: true, restoredText: steeredMessageText(removed) };
  }

  /** dedupeKeys of steers still pending in the buffer. The client polls this
   * (watcher-dock style): key present = Steering; key gone = drained/Sent. */
  async pendingSteerKeys(): Promise<string[]> {
    return this.injectionBuffer().pendingKeys("user-message");
  }

  /** Pending steers WITH their text, so the client can rebuild the chip strip on
   * mount/refresh (ephemeral local state is lost on reload). Each steered
   * message's id IS its clientMessageId (see buildSteeredUserMessage), so it
   * reads straight off the buffer. Only still-buffered (Steering) steers survive
   * a refresh; a drained-but-not-settled (Sent) steer is neither here nor in the
   * transcript yet, and reappears when the turn ends. */
  async listPendingSteers(): Promise<{ clientMessageId: string; text: string }[]> {
    return this.injectionBuffer()
      .peekAll()
      .filter((e) => e.kind === "user-message")
      .map((e) => ({ clientMessageId: e.message.id, text: steeredMessageText(e.message) }));
  }

  async compactThread(): Promise<CompactThreadOutcome> {
    await this.assertThreadWritable();
    const stable = await this.waitUntilStable({ timeout: MANUAL_COMPACT_STABLE_TIMEOUT_MS });
    if (!stable) {
      throw new Error("thread_compaction_not_stable");
    }
    // The handler owns `compactionPhase` (its finally must not flip a *concurrent*
    // run back to idle); this path only declares who triggered the run.
    this._compactionSource = "manual";
    this.takeLastCompactionOutcome();
    let result: Awaited<ReturnType<Session["compact"]>>;
    try {
      result = await this.session.compact();
    } finally {
      this._compactionSource = "append";
      // Manual compaction runs OUTSIDE a turn, so nothing else ever flushes the
      // summarizer's usage. Flush here so it's never lost, whether the summarizer
      // succeeded, found nothing to do, or blew up. `flushTurnUsage()` is a
      // synchronous snapshot-and-swap and a no-op when empty, so this is safe on
      // every exit path.
      await this.flushTurnUsage();
    }
    if (!result) {
      // Session.compact() returns null both when there was nothing to do AND when
      // the summarizer blew up — the outcome is the only way to tell them apart,
      // and a failure must not surface as "Nothing to compact yet."
      const outcome = this.takeLastCompactionOutcome();
      if (outcome?.status === "failed") {
        throw new Error(`thread_compaction_failed: ${outcome.error}`);
      }
      // A decline is not "nothing to compact": there IS a middle, but every
      // span that would fit needs history thrown away, and a manual trigger
      // never does that. Say so, rather than implying the thread is small.
      if (outcome?.status === "declined") {
        return {
          compacted: false,
          reason: "declined",
          message: "Couldn't compact further without discarding history.",
        };
      }
      return { compacted: false, reason: "not-needed", message: "Nothing to compact yet." };
    }
    return { compacted: true, message: "Thread compacted." };
  }

  getCompactionStatus(): { phase: CompactionPhase } {
    return { phase: this.compactionPhase };
  }

  async getDraft(): Promise<string> {
    return (await this.ctx.storage.get<string>(DRAFT_STORAGE_KEY)) ?? "";
  }

  async setDraft(text: string): Promise<void> {
    await this.assertThreadWritable();
    if (text.trim() === "") {
      await this.ctx.storage.delete(DRAFT_STORAGE_KEY);
      return;
    }
    await this.ctx.storage.put(DRAFT_STORAGE_KEY, text);
  }

  /**
   * The owning workspace member's email, for the same `required-viewerEmail`
   * gate `isUsableProviderForWorkspace` enforces elsewhere (see
   * `automaton-tools.ts`'s `resolveService`, which sources it identically).
   * `null` when the workspace has no owner row — a provider gated on viewer
   * email then correctly fails closed instead of being silently offered.
   */
  private async viewerEmailForModelSelection(): Promise<string | null> {
    const { workspaceId } = await this.resolveRuntimeConfigForThink();
    const workspaces = new WorkspaceRepository(registryDb(this.env));
    return workspaces.getOwnerEmail(workspaceId);
  }

  /**
   * Commit the model switch the client requested on the message(s) that
   * triggered THIS turn — read off `UIMessage.metadata`, never stored in DO
   * storage: picking a model is pure client state (see `App.tsx`) and does
   * no I/O until the message that asserts it is actually sent. Called at the
   * TOP of `beforeTurn`, before the turn's runtime config is resolved, so
   * the turn runs on the new model rather than one turn late.
   *
   * Committing here — after the user message that triggered this turn is
   * already appended — is what makes the Anthropic thinking/tool_use
   * ordering rule unreachable: with extended thinking on, an assistant turn
   * containing `tool_use` must open with a thinking block, and switching
   * models while the last assistant message still held a live tool call
   * would make the sanitizer strip that foreign thinking block and leave
   * `tool_use` first — a 400. The last assistant message cannot hold a live
   * tool call at this point in the turn, but the guard below asserts that
   * rather than assuming it (a repair gap upstream could still leave one).
   * `think-model-messages-override.test.ts` and `model-switch-commit.test.ts`
   * establish the stub-`this.messages` / stub-`_incompleteToolCallIds`
   * pattern this guard is tested with.
   *
   * `effectiveModelSwitchRequest` scans the TRAILING run of user messages in
   * `this.messages` for the last one carrying a request — one message for a
   * direct send, several for a flushed queued batch (Think applies a
   * submission's whole message array, then runs one turn over it), so this
   * one scan is both send paths' source with no branching between them.
   *
   * Validation is `resolveThreadModelSnapshotValue` — the SAME call
   * `createThread`/the HTTP model-switch route use — run HERE, at commit
   * time, against the request the client asserted. That is the only gate: a
   * client-asserted request is safe precisely because this call still checks
   * workspace provider config and the whitelist before anything is written.
   * A refusal is logged and the turn proceeds on the thread's EXISTING
   * model — it must never abort the user's turn over a rejected switch.
   */
  private async commitPendingModelSwitch(): Promise<ModelSwitchData | null> {
    const request = effectiveModelSwitchRequest(this.messages);
    if (!request) return null;

    const incompleteToolCallIds = (
      this as unknown as { _incompleteToolCallIds(messages: UIMessage[]): string[] }
    )._incompleteToolCallIds(this.messages);
    if (incompleteToolCallIds.length > 0) {
      log.warn("think_thread.model_switch_deferred", {
        threadId: this.name,
        reason: "incomplete_tool_calls",
      });
      return null;
    }

    const runtimeConfig = await this.resolveRuntimeConfigForThink();
    const from = {
      provider: runtimeConfig.modelConfig.provider,
      model: runtimeConfig.modelConfig.model,
    };
    const validated = await resolveThreadModelSnapshotValue(
      this.env,
      {
        workspaceId: runtimeConfig.workspaceId,
        provider: runtimeConfig.modelConfig.provider,
        model: runtimeConfig.modelConfig.model,
        modelInputModalities: JSON.stringify(runtimeConfig.modelConfig.modelInputModalities),
        reasoningEffort: runtimeConfig.modelConfig.reasoningEffort,
        modelSupportsReasoning: runtimeConfig.modelConfig.modelSupportsReasoning ?? null,
      },
      {
        provider: request.provider,
        model: request.model,
        // Pass through only when supplied, so an omitted field inherits the
        // target above rather than being coerced to `undefined` under
        // `exactOptionalPropertyTypes` (symmetric with `createThread` in
        // `thread-routes.ts`).
        ...(request.modelInputModalities !== undefined
          ? { modelInputModalities: request.modelInputModalities }
          : {}),
        ...(request.modelSupportsReasoning !== undefined
          ? { modelSupportsReasoning: request.modelSupportsReasoning }
          : {}),
      },
      await this.viewerEmailForModelSelection(),
    );
    if (!validated.ok) {
      // Logged, not returned anywhere the client can read: a refused switch
      // is invisible in production otherwise — this is the line that says
      // WHICH provider/model the workspace refused and why. The turn keeps
      // running on `from`; nothing here aborts it.
      log.warn("think_thread.model_switch_rejected", {
        threadId: this.name,
        workspaceId: runtimeConfig.workspaceId,
        provider: request.provider,
        model: request.model,
        error: validated.error,
      });
      return null;
    }

    const to = { provider: validated.value.provider, model: validated.value.model };
    if (sameModelTuple(from, to)) return null;

    await new ThreadRepository(registryDb(this.env)).updateModelSnapshot(
      this.name,
      validated.value,
    );
    // The config just changed underneath the per-wake cache `beforeTurn`
    // already fetched via the call above — invalidate so the SAME turn's
    // `resolveRuntimeConfigForThink` read (right after this call returns)
    // sees the committed switch instead of replaying the stale `from` value.
    this._runtimeConfig.invalidate();
    // The transcript's record of the switch, written by the SERVER — the only
    // component that knows a switch actually committed. The client attaches
    // nothing: a commit can originate from an automaton run or either send
    // path, and the server is the only one of those that can write a marker
    // every one of them agrees on.
    await this.recordCommittedModelSwitch({ from, to });
    log.info("think_thread.model_switched", { threadId: this.name, from, to });
    return { from, to };
  }

  /**
   * Record a committed switch in BOTH places it has to exist.
   *
   * 1. DO storage (`modelSwitch:origin`) — the durable copy. The transcript
   *    marker sits inside a message and compaction archives messages, so the
   *    transcript alone cannot be trusted to still hold it;
   *    `restoreModelSwitchMarker` rebuilds the marker from this record during
   *    model-message assembly.
   * 2. The transcript itself, as a `data-model-switch` part prepended to the
   *    message the switch commits against (the turn's triggering user
   *    message). This is what the UI renders the divider from, and it keeps
   *    the divider exactly where the client used to put it.
   *
   * The transcript write is best-effort — it must never fail a turn — which is
   * safe precisely because (1) is the copy the sanitizer can always fall back
   * to. Idempotent: a message already carrying a marker for this `to` (an
   * older client that still attaches its own) is left alone, so one switch can
   * never render two dividers.
   */
  private async recordCommittedModelSwitch(data: ModelSwitchData): Promise<void> {
    const anchor = this.modelSwitchAnchorMessage();
    const origin: ModelSwitchOrigin = {
      ...data,
      ...(anchor ? { anchorMessageId: anchor.id } : {}),
    };
    await this.ctx.storage.put(MODEL_SWITCH_ORIGIN_STORAGE_KEY, origin);
    this._modelSwitchOrigin = origin;
    if (!anchor) return;
    const alreadyMarked = anchor.parts.some((part) => {
      const marker = readModelSwitchPart(part);
      return marker !== null && sameModelTuple(marker.to, data.to);
    });
    if (alreadyMarked) return;
    try {
      await this.addMessages(
        [
          {
            ...anchor,
            parts: [
              modelSwitchPart(data) as unknown as UIMessage["parts"][number],
              ...anchor.parts,
            ],
          },
        ],
        { mode: "upsert" },
      );
    } catch (error) {
      log.warn("think_thread.model_switch_marker_write_failed", {
        threadId: this.name,
        error: String(error),
      });
    }
  }

  /** The message a committed switch hangs its marker on: the turn's
   *  triggering user message (the commit runs after it is appended), so the
   *  divider renders above it — the placement the client used to produce. */
  private modelSwitchAnchorMessage(): UIMessage | undefined {
    const messages = this.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message && message.role === "user") return message;
    }
    return messages[messages.length - 1];
  }

  /** The durable current-segment record, memoized per instance (assembly runs
   *  on every step, and the record only changes when a commit rewrites it). */
  private async currentModelSwitchOrigin(): Promise<ModelSwitchOrigin | null> {
    if (this._modelSwitchOrigin !== undefined) return this._modelSwitchOrigin;
    const stored =
      (await this.ctx.storage.get<ModelSwitchOrigin>(MODEL_SWITCH_ORIGIN_STORAGE_KEY)) ?? null;
    this._modelSwitchOrigin = stored;
    return stored;
  }

  /** Test seam: runs the SDK drain loop so a waiting queued batch actually
   *  executes its turn, following the `_test*`/`ForTest` naming already used
   *  in this class. Thin wrapper over Think's own (unsafe-cast) drain hook,
   *  same seam `queued-user-messages` integration coverage already uses. */
  async drainQueuedUserMessagesForTest(): Promise<void> {
    await (this as unknown as { _drainThinkSubmissions(): Promise<void> })._drainThinkSubmissions();
  }

  /**
   * Return this thread's FULL persisted transcript. The archive routine calls
   * this over RPC to snapshot history to D1 before destroying the DO.
   *
   * Reads through `session.getHistory()`, not `this.messages`: the latter is a
   * hydration cache bounded by `hydrationByteBudget`, so on a large transcript
   * it is only a recent window. Snapshotting that window and then destroying the
   * DO would silently drop everything older. `getHistory()` is the unbudgeted
   * durable path; it can OOM on a pathological transcript, but that throws and
   * the caller aborts the archive (nothing is destroyed).
   */
  async exportHistory() {
    const messages = await this.session.getHistory();
    return Array.isArray(messages) ? messages.map((m) => this.stampDurations(m)) : messages;
  }

  private thinkTranscriptSource(): TranscriptSource {
    return {
      listStats: (input) => this.listThinkTranscriptStats(input),
      getMessage: (id) => this.getThinkTranscriptMessage(id),
    };
  }

  private async listThinkTranscriptStats(input: {
    afterPosition?: number;
    order: ThreadOrder;
    limit: number;
  }): Promise<{ stats: RawTranscriptStat[]; nextPosition?: number }> {
    const stats = ((await this.session.getHistoryRowStats()) ?? [])
      .map((row, position) => ({
        id: row.id,
        position,
        bytes: typeof row.bytes === "number" ? row.bytes : 0,
      }))
      .filter((row) => !isSyntheticCompactionId(row.id));
    return pageTranscriptStats(stats, input);
  }

  private async getThinkTranscriptMessage(id: string): Promise<unknown | null> {
    if (isSyntheticCompactionId(id)) return null;
    const message = await this.session.getMessage(id);
    if (message === null || message === undefined) return null;
    if (typeof message !== "object") return message;
    const candidate = message as { createdAt?: unknown };
    if ("createdAt" in candidate && candidate.createdAt !== undefined) return message;
    const createdAt = this.readStoredMessageCreatedAt(id);
    return this.stampDurations(createdAt === undefined ? message : { ...message, createdAt });
  }

  private readStoredMessageCreatedAt(id: string): unknown | undefined {
    try {
      const rows = this.sql<{ created_at: unknown }>`
        SELECT created_at FROM assistant_messages WHERE id = ${id} LIMIT 1
      `;
      return rows[0]?.created_at;
    } catch {
      return undefined;
    }
  }

  async readThreadProsePage(input: InternalReadRequest): Promise<InternalReadResult> {
    return readTranscriptPage(this.thinkTranscriptSource(), input);
  }

  async grepThreadProse(input: InternalGrepRequest): Promise<InternalGrepResult> {
    return grepTranscript(this.thinkTranscriptSource(), input);
  }

  async listThreadSearchDigests(input: { afterPosition?: number; limit: number }): Promise<{
    digests: ThreadSearchDigest[];
    nextPosition?: number;
    lastMessagePreview: string;
  }> {
    const cappedLimit = capDigestLimit(input.limit);
    const page = await this.listThinkTranscriptStats({
      ...(input.afterPosition === undefined ? {} : { afterPosition: input.afterPosition }),
      order: "chronological",
      limit: cappedLimit,
    });
    const digests: ThreadSearchDigest[] = [];
    let lastMessagePreview = "";
    for (const stat of page.stats) {
      const raw = await this.getThinkTranscriptMessage(stat.id);
      const normalized = normalizeProseMessage(raw);
      if (normalized.message !== null) {
        lastMessagePreview = previewText(normalized.message.text);
      }
      digests.push({
        messageId: stat.id,
        sourceHash: await sourceHash(raw),
        indexable: normalized.message !== null,
      });
    }
    return {
      digests,
      ...(page.nextPosition === undefined ? {} : { nextPosition: page.nextPosition }),
      lastMessagePreview,
    };
  }

  async getThreadSearchDocuments(messageIds: string[]): Promise<ThreadSearchDocument[]> {
    const documents: ThreadSearchDocument[] = [];
    for (const messageId of messageIds.slice(0, THREAD_PROJECTION_DOCUMENT_BATCH)) {
      const raw = await this.getThinkTranscriptMessage(messageId);
      const normalized = normalizeProseMessage(raw);
      if (normalized.message === null) continue;
      documents.push({
        message: normalized.message,
        sourceHash: await sourceHash(raw),
      });
    }
    return documents;
  }

  /**
   * The RAW transcript — every stored message, with no compaction overlays applied.
   *
   * `exportHistory()` returns `session.getHistory()`, which replaces each compacted
   * span with a single synthetic summary. That is the right view for the model and
   * for the live UI, but it is the WRONG thing to archive: archiving snapshots and
   * then DESTROYS the Durable Object, so every message behind a summary would be
   * gone for good. The archive is the record; it must hold what actually happened.
   *
   * Reads the path rows directly (`getHistoryRowStats` gives the path in order,
   * `getMessage` reads each row) rather than through the overlay-applying accessor.
   */
  async exportRawHistory(): Promise<unknown[]> {
    const stats = (await this.session.getHistoryRowStats()) ?? [];
    const messages: unknown[] = [];
    for (const row of stats) {
      // A synthetic overlay must never have been persisted as a message (see the
      // `_persistIncomingMessage` override); skip any that predate that fix, so a
      // poisoned row cannot ride into the archive as a real message.
      if (row.id.startsWith("compaction_")) continue;
      const message = await this.session.getMessage(row.id);
      // Refuse to return a PARTIAL transcript. The caller archives this and then
      // destroys the DO, so quietly dropping a row it could not read would delete
      // that message for good — the same irreversible mistake the empty-snapshot
      // guard exists to prevent, one row at a time. Fail the archive instead;
      // nothing is destroyed and the cron retries.
      if (!message) {
        throw new Error(`export_raw_history_missing_message:${row.id}`);
      }
      // Stamp here, not only on the live read: archiving snapshots this into D1
      // and then DESTROYS the DO, so a duration missing at this moment is
      // missing for the life of the thread.
      messages.push(this.stampDurations(message));
    }
    return messages;
  }

  /** The compaction overlay rows, so an archived thread keeps its summaries. */
  async exportCompactions(): Promise<
    Array<{ id: string; fromMessageId: string; toMessageId: string; summary: string }>
  > {
    const rows = await this.session.getCompactions();
    return rows.map((r) => ({
      id: r.id,
      fromMessageId: r.fromMessageId,
      toMessageId: r.toMessageId,
      summary: r.summary,
    }));
  }

  /**
   * True when the workspace was VERIFIED clean by `confirm_work_saved` and
   * nothing has written to the sandbox since. Not a claim — the tool refuses
   * unless git agrees, so a set bit means the state was checked.
   */
  async getSandboxDeclaredClean(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(SANDBOX_DECLARED_CLEAN_STORAGE_KEY)) ?? false;
  }

  async setSandboxDeclaredClean(clean: boolean): Promise<void> {
    if (clean) {
      await this.ctx.storage.put(SANDBOX_DECLARED_CLEAN_STORAGE_KEY, true);
      return;
    }
    await this.ctx.storage.delete(SANDBOX_DECLARED_CLEAN_STORAGE_KEY);
  }

  /**
   * Invalidate the clean bit for the sandbox THIS agent is about to write to.
   * Wired as `sandboxHostDeps().markSandboxDirty`, i.e. it runs on the write
   * itself, before the command reaches the machine.
   *
   * Overridable because "the sandbox this agent writes to" and "this agent's
   * own storage" are the same thing only for a top-level thread. An attached
   * subagent shares the PARENT's machine, so its writes have to invalidate the
   * parent's bit too — see `SubAgent`'s override.
   */
  protected async clearSandboxDeclaredClean(): Promise<void> {
    await this.setSandboxDeclaredClean(false);
  }

  /** Persist the outcome the automaton run declared via report_run_outcome. */
  async recordAutomatonRunOutcome(outcome: AutomatonRunOutcome): Promise<void> {
    await this.ctx.storage.put(AUTOMATON_OUTCOME_STORAGE_KEY, outcome);
  }

  /** Read-and-clear: an outcome applies to exactly the turn that declared it. */
  private async takeAutomatonRunOutcome(): Promise<AutomatonRunOutcome | null> {
    const outcome =
      (await this.ctx.storage.get<AutomatonRunOutcome>(AUTOMATON_OUTCOME_STORAGE_KEY)) ?? null;
    if (outcome) await this.ctx.storage.delete(AUTOMATON_OUTCOME_STORAGE_KEY);
    return outcome;
  }
}

function isSyntheticCompactionId(id: string): boolean {
  return id.startsWith("compaction_");
}

function pageTranscriptStats(
  stats: RawTranscriptStat[],
  input: { afterPosition?: number; order: ThreadOrder; limit: number },
): { stats: RawTranscriptStat[]; nextPosition?: number } {
  const ordered =
    input.order === "chronological" ? stats : [...stats].sort((a, b) => b.position - a.position);
  const afterIndex =
    input.afterPosition === undefined
      ? -1
      : ordered.findIndex((stat) => stat.position === input.afterPosition);
  const start = afterIndex < 0 ? 0 : afterIndex + 1;
  const page = ordered.slice(start, start + input.limit);
  const last = page.at(-1);
  const hasMore = ordered.length > start + page.length;
  return {
    stats: page,
    ...(hasMore && last !== undefined ? { nextPosition: last.position } : {}),
  };
}

function capDigestLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), THREAD_PROJECTION_DIGEST_PAGE);
}

function previewText(text: string): string {
  return text.slice(0, THREAD_LAST_MESSAGE_PREVIEW_CHARS);
}

async function sourceHash(raw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  return sha256Hex(bytes.buffer);
}

/**
 * Window-scale the model-facing transcript.
 *
 * Think's own `_assembleModelMessages` calls `truncateOlderMessages()` with NO
 * options, so the SDK defaults bind: any message older than the last 4 is sent
 * with its tool output cut to 500 chars — on a 1M-window model exactly as on a
 * 32k one. There is no config knob for it, which is why this reaches for a
 * method Think declares `private`.
 *
 * Nadi bounds per PART instead of per recency: the SDK's `keepRecent` exempts
 * whole recent messages, which meant a short thread whose opening turn held 23
 * tool calls was never bounded at all. See `transcript-bounding.ts`.
 *
 * Why this seam and not `TurnConfig.messages` (which IS public, and which we
 * already use): the proactive context guard rebuilds its head by calling
 * `_assembleModelMessages` internally. Overriding only the public seam would
 * leave mid-turn recompaction silently reverting to SDK-default truncation for
 * that step. This is the one place both paths go through.
 *
 * The `private` declaration is TypeScript-only (these are ordinary prototype
 * methods at runtime). It is installed on the prototype rather than declared as
 * a class method because TS rejects redeclaring a base-class private member on
 * the `extends` clause itself (TS2415) — where no `@ts-expect-error` can reach,
 * and where relaxing the base type would strip Think's protected surface from
 * the whole class. `test/unit/agent/think-sdk-contract.test.ts` fails loudly if
 * an SDK upgrade renames either method — without it, a broken override would
 * silently degrade context quality with every test still green.
 */
async function assembleWindowScaledModelMessages(
  this: ThinkThreadAgent,
  tools: ToolSet,
): Promise<ModelMessage[]> {
  const self = this as unknown as {
    messages: UIMessage[];
    currentContextBudget(): Promise<ContextBudget>;
    _repairTranscriptForProvider(messages: UIMessage[]): Promise<UIMessage[]>;
    currentModelSwitchOrigin(): Promise<ModelSwitchOrigin | null>;
    _incompleteToolCallIds(messages: UIMessage[]): string[];
    _emit(event: string, payload: Record<string, unknown>): void;
  };
  const budget = await self.currentContextBudget();
  const repaired = await self._repairTranscriptForProvider(self.messages);
  // Rebuild the segmentation marker from DO storage when the transcript no
  // longer carries it — compaction archives whole spans of messages, marker
  // included, and a marker-less transcript reads as one same-origin segment.
  // See `restoreModelSwitchMarker`.
  const segmented = restoreModelSwitchMarker(repaired, await self.currentModelSwitchOrigin());
  // Cross-model reasoning is dropped BEFORE truncation: a reasoning block that
  // will not be sent must not consume the truncation budget. Markers are still
  // present here and are gone after convertToModelMessages, so this is the only
  // seam where the segment origins are readable.
  const sanitized = sanitizeCrossModelReasoning(segmented);
  const truncated = boundTranscript(sanitized, boundingOptionsFor(budget)) as typeof sanitized;
  // Same post-repair diagnostic Think's own _assembleModelMessages runs: a
  // survivor here means _repairToolTranscriptParts has a gap, even though
  // ignoreIncompleteToolCalls keeps the turn itself safe.
  const incompleteAfterRepair = self._incompleteToolCallIds(truncated as unknown as UIMessage[]);
  if (incompleteAfterRepair.length > 0) {
    console.warn(
      `[Think] ${incompleteAfterRepair.length} incomplete tool call(s) survived transcript repair and will be dropped by ignoreIncompleteToolCalls: ${incompleteAfterRepair.join(", ")}. This indicates a gap in _repairToolTranscriptParts.`,
    );
    self._emit("chat:transcript:repaired", {
      removedToolCalls: incompleteAfterRepair.length,
      normalizedInputs: 0,
      toolCallIds: incompleteAfterRepair,
    });
  }
  return convertToModelMessages(truncated as unknown as UIMessage[], {
    tools,
    ignoreIncompleteToolCalls: true,
  });
}

Object.defineProperty(ThinkThreadAgent.prototype, "_assembleModelMessages", {
  value: assembleWindowScaledModelMessages,
  writable: true,
  configurable: true,
});

/**
 * Label the auto-guard compactions truthfully.
 *
 * Think drives both overflow layers through `session.compact()`, so the
 * `onCompaction` handler cannot tell a mid-turn proactive trim from a post-error
 * reactive one and logged BOTH as `source: "append"` — a wrong label, not a
 * missing one, and one that would mislead whoever reads these logs during an
 * incident. `_compactForContextOverflow(reason, extra)` is the single funnel for
 * both ("proactive" | "reactive"), so stamping the source here and delegating is
 * the smallest place the truth is available. Same prototype-patch shape (and same
 * TS-private caveat) as `_assembleModelMessages`; `think-sdk-contract.test.ts`
 * fails loudly if an SDK upgrade renames it.
 */
type CompactForContextOverflow = (
  this: ThinkThreadAgent,
  reason: "proactive" | "reactive",
  extra?: Record<string, unknown>,
) => Promise<boolean>;

const compactForContextOverflowOverride: CompactForContextOverflow = async function (
  this: ThinkThreadAgent,
  reason,
  extra,
) {
  const self = this as unknown as { _compactionSource: CompactionSource };
  const previous = self._compactionSource;
  self._compactionSource = reason;
  try {
    const base = Think.prototype as unknown as {
      _compactForContextOverflow: CompactForContextOverflow;
    };
    return await base._compactForContextOverflow.call(this, reason, extra);
  } finally {
    self._compactionSource = previous;
  }
};

Object.defineProperty(ThinkThreadAgent.prototype, "_compactForContextOverflow", {
  value: compactForContextOverflowOverride,
  writable: true,
  configurable: true,
});

/**
 * Never persist a compaction overlay.
 *
 * A compaction summary is SYNTHETIC: `applyCompactions` renders it at read time
 * from the `assistant_compactions` rows, with the id `compaction_<rowId>`. It is a
 * view, not a message — nothing should ever write one into `assistant_messages`.
 *
 * But Think broadcasts that rendered view to the client, and when the client sends
 * its next message it posts its whole list back. The server reconciles against RAW
 * storage (`_readMessagesFromStorage`, which has no overlays), so the overlay looks
 * like a brand-new message and is upserted as a real row.
 *
 * The summary then stops being a view and becomes a permanent fake message: it
 * renders once from the rows AND once from the persisted row, so the thread shows
 * two "Thread compacted" dividers and the model reads the same summary twice —
 * wasted context that compounds with every compaction. Found in production on a
 * thread that compacted while the user was sending the next message.
 */
const persistIncomingMessageOverride = async function (
  this: ThinkThreadAgent,
  msg: { id?: string },
  serverMessages: unknown,
): Promise<unknown> {
  if (typeof msg?.id === "string" && msg.id.startsWith("compaction_")) {
    log.warn("think_thread.overlay_persist_blocked", { threadId: this.name, messageId: msg.id });
    return undefined;
  }
  const base = Object.getPrototypeOf(ThinkThreadAgent.prototype) as {
    _persistIncomingMessage(msg: unknown, serverMessages: unknown): Promise<unknown>;
  };
  return base._persistIncomingMessage.call(this, msg, serverMessages);
};

Object.defineProperty(ThinkThreadAgent.prototype, "_persistIncomingMessage", {
  value: persistIncomingMessageOverride,
  writable: true,
  configurable: true,
});

callable()(ThinkThreadAgent.prototype.ping, null as unknown as ClassMethodDecoratorContext);
callable()(
  ThinkThreadAgent.prototype.hasActiveTurn,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.compatibilityReport,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.providerProbeForTest,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.toolProbeForTest,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.skillProbeForTest,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.beforeTurnToolNamesForTest,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.beforeTurnActiveToolsForTest,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.submitQueuedUserMessage,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.listQueuedUserMessages,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.cancelQueuedUserMessage,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(ThinkThreadAgent.prototype.steer, null as unknown as ClassMethodDecoratorContext);
callable()(ThinkThreadAgent.prototype.cancelSteer, null as unknown as ClassMethodDecoratorContext);
callable()(
  ThinkThreadAgent.prototype.pendingSteerKeys,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.listPendingSteers,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.compactThread,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.getCompactionStatus,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(ThinkThreadAgent.prototype.getDraft, null as unknown as ClassMethodDecoratorContext);
callable()(ThinkThreadAgent.prototype.setDraft, null as unknown as ClassMethodDecoratorContext);
// Picking a model is now pure client state (see `App.tsx`) — no RPC to
// register. The choice rides on the message that commits it, over the
// `submitQueuedUserMessage`/normal send wire the callable list already
// covers below.
callable()(
  ThinkThreadAgent.prototype.exportHistory,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.exportRawHistory,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.readThreadProsePage,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.grepThreadProse,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.listThreadSearchDigests,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.getThreadSearchDocuments,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.exportCompactions,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.cancelSubagentRun,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.listActiveWatchers,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.listBackgroundWork,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.readBackgroundWorkOutput,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.cancelBackgroundWork,
  null as unknown as ClassMethodDecoratorContext,
);
callable()(
  ThinkThreadAgent.prototype.clearFinishedBackgroundWork,
  null as unknown as ClassMethodDecoratorContext,
);
// `reportProcessCompletion` is deliberately NOT `callable()`. The HTTP route
// reaches it through a plain DO stub (`getAgentByName(...).reportProcessCompletion`,
// completion-routes.ts) — the same way `debugSandboxReset` and its neighbours are
// called, none of which is decorated either. Registering it would additionally
// expose it to any session-authorized browser client of this thread, which could
// then fabricate a process completion; `completion-routes.ts` says the HMAC is
// the entire gate, and that is only true while this stays unregistered.
callable()(
  ThinkThreadAgent.prototype.debugThreadKnowledgeTools,
  null as unknown as ClassMethodDecoratorContext,
);

/**
 * Build the PLAIN user message a finished subagent injects into the parent
 * chat. No `nadiKind` metadata: it stays VISIBLE in the transcript and the
 * client renders it via `SUBAGENT_COMPLETION_RE` (matching today's SDK-delivered
 * shape — see web/src/lib/subagent-runs.ts). `formatSubagentCompletion` already
 * wraps the body in `<system-reminder>`, so the text goes straight into the part.
 *
 * The message id is DETERMINISTIC (`subagent_${runId}_finish`), not a random
 * uuid: the buffer's dedupe key only protects the entry while it sits in the
 * buffer, but the SDK's at-least-once reconcile can re-fire
 * `_deliverDetachedTerminal("finish")` AFTER the buffer has already drained.
 * A deterministic id means the re-fire's `addMessages` collapses onto the
 * same message instead of appending a second completion card.
 */
function buildSubagentCompletionMessage(
  runId: string,
  result: AgentToolLifecycleResult,
  label?: string,
  actor?: WorkStopActor,
): UIMessage {
  const text = formatSubagentCompletion({
    runId,
    ...(label ? { label } : {}),
    status: result.status,
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(actor ? { actor } : {}),
  });
  return { id: `subagent_${runId}_finish`, role: "user", parts: [{ type: "text", text }] };
}

/**
 * Override of the SDK-internal prompt-detection funnel for detached subagent
 * terminals (`_deliverDetachedTerminal(runId, kind, result, options, completedAt)`).
 * This is the earliest point that can run mid-parent-turn (via `waitUntil`/
 * reconcile), BEFORE the SDK defers its OWN delivery onto the turn queue inside
 * the base method. We enqueue the completion into the injection buffer HERE so a
 * mid-turn parent STEERS it into the running turn's next step, and suppress the
 * SDK's deferred submission by returning `""` from `formatDetachedCompletion`
 * (its `_cfDetachedNotifyFinish` early-returns on empty text) — the pair is
 * exactly-once.
 *
 * Only the `finish` slot (the real terminal) injects. `give_up` is skipped: it
 * is an early "stopped waiting" signal that the reconcile backbone always
 * follows with a real `finish`, so injecting on it would duplicate. The
 * soft-interrupt guard mirrors `onAgentToolFinish` / the old
 * `formatDetachedCompletion`. `deliverInjection`'s `dedupeKey` makes a
 * re-delivered terminal (crash + reconcile) idempotent.
 *
 * Installed on the PROTOTYPE rather than as a class member because the SDK's
 * base `Agent` declares `_deliverDetachedTerminal` as `private`: a class-body
 * override trips TS2415 and cascades assignability errors everywhere
 * ThinkThreadAgent/SubAgent is used as an `Agent`. Prototype installation keeps
 * the class TYPE free of the member (assignability holds) while the runtime
 * prototype correctly shadows the SDK method. `Think.prototype`'s method is
 * `Object.getPrototypeOf(ThinkThreadAgent.prototype)` — exactly what `super`
 * binds to — so calling it via `.call(this, …)` is depth-safe and never
 * re-enters this override (SubAgent instances reuse it identically).
 *
 * PINNED to the agents SDK — see test/integration/subagent-detached-injection.test.ts.
 */
type DeliverDetachedTerminal = (
  this: ThinkThreadAgent,
  runId: string,
  kind: string,
  result: AgentToolLifecycleResult,
  options?: unknown,
  completedAt?: number,
) => Promise<void>;

const deliverDetachedTerminalOverride: DeliverDetachedTerminal = async function (
  this: ThinkThreadAgent,
  runId,
  kind,
  result,
  options,
  completedAt,
) {
  if (
    kind === "finish" &&
    !(result.status === "interrupted" && result.childStillRunning) &&
    // The reaper already delivered this run's terminal and then killed it, and
    // that kill is what re-entered the SDK to produce THIS call. Injecting again
    // would follow "the sandbox was reset, all files are lost" with a redundant
    // card saying the subagent was cancelled. See `reaperAlreadyReported` for
    // why this cannot swallow a normal completion.
    !this.reaperAlreadyReported(runId)
  ) {
    // Recover the run's label (its `inputPreview`) from the SDK's internal run
    // row, behind the SAME isolated/pinned seam as this override itself (see
    // test/integration/subagent-detached-injection.test.ts). Defensive: never
    // throw — an absent method or missing preview just falls back to no label
    // (today's "(unlabeled)" rendering in formatSubagentCompletion).
    //
    // The `input_preview` COLUMN is stored JSON-encoded (the SDK does
    // `JSON.stringify(inputPreview)` — index.js:4327), so parse it back to the
    // clean value the old `formatDetachedCompletion` path used (it received the
    // parsed `AgentToolRunInfo.inputPreview`) — see unwrapStoredInputPreview.
    const label = unwrapStoredInputPreview(
      (
        this as unknown as {
          _readAgentToolRun?: (id: string) => { input_preview?: string } | undefined;
        }
      )._readAgentToolRun?.(runId)?.input_preview,
    );
    this.deliverInjection({
      dedupeKey: `subagent:${runId}:${kind}`,
      kind: "subagent-completion",
      // An `aborted` run reads identically whether a human pressed stop, the
      // model called `stop_subagent`, or a budget ran out — and those imply
      // opposite next moves. The row is where the answer was recorded.
      message: buildSubagentCompletionMessage(runId, result, label, this.stopActorFor(runId)),
    });
  }
  // `give_up` (budget-exceeded) is intentionally NOT surfaced here: the
  // reconcile backbone always follows it with a real `finish` (which is
  // `aborted` in the common case) that we DO inject on above. The one
  // uncovered case is a `give_up` whose child teardown throws
  // (`childStillRunning`), which we accept as a rare gap rather than risk
  // double-injecting on both slots.
  const base = Think.prototype as unknown as { _deliverDetachedTerminal: DeliverDetachedTerminal };
  await base._deliverDetachedTerminal.call(this, runId, kind, result, options, completedAt);
};

(
  ThinkThreadAgent.prototype as unknown as { _deliverDetachedTerminal: DeliverDetachedTerminal }
)._deliverDetachedTerminal = deliverDetachedTerminalOverride;
