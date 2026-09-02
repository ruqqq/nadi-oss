import {
  DEFAULT_REASONING_EFFORT,
  parseReasoningEffort,
  type ReasoningEffort,
} from "../agent/reasoning-options";
import type { ThreadRuntime } from "../agent/thread-runtime";
import { DEFAULT_COMPUTE_RESOURCE_PROFILE, isComputeResourceProfile } from "../compute/config";
import type { ComputeResourceProfile } from "../compute/types";

export type ThreadActivityStatus = "idle" | "running" | "attention_required" | "failed";
export type ThreadUnreadOutcome = "completed" | "failed" | null;

/**
 * Why a thread refuses new turns. The thread's OWN state outranks its agent's:
 * an archived thread is read-only for a reason the reader chose and can undo,
 * and naming the agent instead would send them to fix the wrong thing.
 * `thread_archived` and `legacy_runtime` never co-occur with a user-visible
 * difference — both render today's wording — so their relative order is
 * cosmetic; the agent reasons are the ones that carry new copy.
 */
export type ThreadReadOnlyReason =
  | "thread_archived"
  | "legacy_runtime"
  | "agent_deleted"
  | "agent_disabled";

export interface ThreadSummary {
  threadId: string;
  kind: "regular" | "feedback";
  workspaceId: string;
  agentId: string;
  provider: string;
  model: string;
  modelInputModalities: string[];
  /** Thread snapshot; missing/invalid values serialize as the runtime default. */
  reasoningEffort: ReasoningEffort;
  /** NULL = unknown — never conflate with false. */
  modelSupportsReasoning: boolean | null;
  runtime: ThreadRuntime;
  activityStatus: ThreadActivityStatus;
  currentTurnStartedAt: number | null;
  attentionRequiredAt: number | null;
  title: string;
  source: "manual" | "automaton";
  lastMessagePreview: string;
  unreadOutcome: ThreadUnreadOutcome;
  unreadOutcomeAt: number | null;
  lastSeenAt: number | null;
  archivedAt: number | null;
  readOnly: boolean;
  /** Absent when `readOnly` is false, and absent from any payload written
   *  before this field existed — a client MUST treat it as optional and fall
   *  back to generic read-only copy. */
  readOnlyReason?: ThreadReadOnlyReason;
  status: "active" | "archived";
  projectId: string | null;
  projectName: string | null;
  agentName: string | null;
  /** The agent's sandbox size, read LIVE: configuration is not snapshotted per
   * thread, so editing it takes effect on the next acquire. */
  resourceProfile: ComputeResourceProfile;
  automatonId: string | null;
  automatonName: string | null;
  automatonNotifyMode: "all" | "failures_only" | null;
  outcomeDismissedAt: number | null;
  /** Set while the user has dismissed this thread from the sidebar rail. The
   * rail hides it only while `recentDismissedAt >= updatedAt`; every other
   * surface ignores this field. See `thread_index.recent_dismissed_at`. */
  recentDismissedAt: number | null;
  repositoryCount: number;
  /** NULL means "not tracked" — a pre-feature thread, or one that never ran a turn. NOT zero. */
  lastContextTokens: number | null;
  lastContextWindow: number | null;
  /** The turn's real compaction trigger. NULL means the client warns at nothing. */
  lastCompactAfterTokens: number | null;
  createdAt: number;
  updatedAt: number;
}

export function serializeThread(input: {
  id: string;
  kind?: "regular" | "feedback" | null;
  workspaceId: string;
  agentId: string;
  modelProvider?: string | null;
  model?: string | null;
  modelInputModalities?: string | null;
  reasoningEffort?: string | null;
  modelSupportsReasoning?: boolean | null;
  runtime: ThreadRuntime;
  activityStatus?: ThreadActivityStatus | null;
  currentTurnStartedAt?: number | null;
  attentionRequiredAt?: number | null;
  title: string;
  source: "manual" | "automaton";
  lastMessagePreview: string;
  unreadOutcome?: ThreadUnreadOutcome;
  unreadOutcomeAt?: number | null;
  lastSeenAt?: number | null;
  archivedAt?: number | null;
  /**
   * The AGENT's live state, read from the joined `agents` row — deliberately
   * REQUIRED, unlike the other join-supplied fields above. A caller that omits
   * them is a compile error, because a thread serialized without them renders a
   * working composer for an agent that will refuse the turn, and nothing else
   * would fail. `agentEnabled: null` is "no agent row joined" (unknown), not
   * "disabled".
   */
  agentArchivedAt: number | null;
  agentEnabled: boolean | null;
  projectId?: string | null;
  projectName?: string | null;
  agentName?: string | null;
  /** Raw `agents.resource_profile`, validated and defaulted below. Still
   * optional: a caller that serializes a bare `thread_index` row without the
   * agent join has no value for it. */
  snapshotResourceProfile?: string | null;
  automatonId?: string | null;
  automatonName?: string | null;
  automatonNotifyMode?: "all" | "failures_only" | null;
  outcomeDismissedAt?: number | null;
  recentDismissedAt?: number | null;
  repositoryCount?: number | null;
  lastContextTokens?: number | null;
  lastContextWindow?: number | null;
  lastCompactAfterTokens?: number | null;
  createdAt: number;
  updatedAt: number;
}): ThreadSummary {
  const readOnlyReason = resolveReadOnlyReason(input);
  return {
    threadId: input.id,
    kind: input.kind ?? "regular",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    provider: input.modelProvider ?? "",
    model: input.model ?? "",
    modelInputModalities: parseStoredModelInputModalities(input.modelInputModalities),
    reasoningEffort: parseReasoningEffort(input.reasoningEffort) ?? DEFAULT_REASONING_EFFORT,
    modelSupportsReasoning: input.modelSupportsReasoning ?? null,
    runtime: input.runtime,
    activityStatus: input.activityStatus ?? "idle",
    currentTurnStartedAt: input.currentTurnStartedAt ?? null,
    attentionRequiredAt: input.attentionRequiredAt ?? null,
    title: input.title,
    source: input.source,
    lastMessagePreview: input.lastMessagePreview,
    unreadOutcome: input.unreadOutcome ?? null,
    unreadOutcomeAt: input.unreadOutcomeAt ?? null,
    lastSeenAt: input.lastSeenAt ?? null,
    archivedAt: input.archivedAt ?? null,
    readOnly: readOnlyReason !== undefined,
    // Spread rather than assigned: `exactOptionalPropertyTypes` rejects
    // `{ readOnlyReason: undefined }` against an optional property.
    ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
    status: input.archivedAt == null ? "active" : "archived",
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    agentName: input.agentName ?? null,
    resourceProfile:
      input.snapshotResourceProfile != null &&
      isComputeResourceProfile(input.snapshotResourceProfile)
        ? input.snapshotResourceProfile
        : DEFAULT_COMPUTE_RESOURCE_PROFILE,
    automatonId: input.automatonId ?? null,
    automatonName: input.automatonName ?? null,
    automatonNotifyMode: input.automatonNotifyMode ?? null,
    outcomeDismissedAt: input.outcomeDismissedAt ?? null,
    recentDismissedAt: input.recentDismissedAt ?? null,
    repositoryCount: input.repositoryCount ?? 0,
    lastContextTokens: input.lastContextTokens ?? null,
    lastContextWindow: input.lastContextWindow ?? null,
    lastCompactAfterTokens: input.lastCompactAfterTokens ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

/**
 * The single source of `readOnly`. It is an EXPLANATION, not the enforcement
 * point: the turn is still refused server-side in `think-thread-agent.ts` (read
 * live from D1) and in `AgentSandbox.acquire`. Both gates stay.
 */
function resolveReadOnlyReason(input: {
  runtime: ThreadRuntime;
  archivedAt?: number | null;
  agentArchivedAt: number | null;
  agentEnabled: boolean | null;
}): ThreadReadOnlyReason | undefined {
  if (input.archivedAt != null) return "thread_archived";
  if (input.runtime === "legacy") return "legacy_runtime";
  if (input.agentArchivedAt != null) return "agent_deleted";
  // `null` is "no agent row joined", which is unknown — only an explicit
  // `false` is the disable.
  if (input.agentEnabled === false) return "agent_disabled";
  return undefined;
}

const MODEL_INPUT_MODALITIES = new Set(["text", "image", "audio", "video", "file"]);

function parseStoredModelInputModalities(value: string | null | undefined): string[] {
  if (!value) return ["text"];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return ["text"];
    const modalities = Array.from(new Set(parsed));
    if (
      modalities.length === 0 ||
      !modalities.every((entry) => typeof entry === "string" && MODEL_INPUT_MODALITIES.has(entry))
    ) {
      return ["text"];
    }
    return modalities;
  } catch {
    return ["text"];
  }
}
