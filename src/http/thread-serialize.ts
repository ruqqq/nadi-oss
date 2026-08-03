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

export interface ThreadSummary {
  threadId: string;
  kind: "regular" | "feedback";
  workspaceId: string;
  agentId: string;
  provider: string;
  model: string;
  modelInputModalities: string[];
  showReasoning: boolean;
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
  status: "active" | "archived";
  projectId: string | null;
  projectName: string | null;
  workbenchId: string | null;
  workbenchName: string | null;
  /** True while a workbench switch is deferred: `workbenchId` is the intent,
   * but the sandbox (and `resourceProfile` below) still reflects the OLD
   * workbench until the agent confirms and the switch commits. */
  workbenchSwitchPending: boolean;
  /** The sandbox size actually in effect, read from the frozen
   * `thread_workbench_snapshots` row — NOT the live workbench, which during a
   * pending switch already names the NEW workbench. */
  resourceProfile: ComputeResourceProfile;
  automatonId: string | null;
  automatonName: string | null;
  automatonNotifyMode: "all" | "failures_only" | null;
  outcomeDismissedAt: number | null;
  /** Set while the user has dismissed this thread from the sidebar rail. The
   * rail hides it only while `recentDismissedAt >= updatedAt`; every other
   * surface ignores this field. See `thread_index.recent_dismissed_at`. */
  recentDismissedAt: number | null;
  repositorySnapshotCount: number;
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
  showReasoning?: boolean | null;
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
  projectId?: string | null;
  projectName?: string | null;
  workbenchId?: string | null;
  workbenchName?: string | null;
  workbenchSwitchPendingAt?: number | null;
  /** Raw `thread_workbench_snapshots.resource_profile` — nullable text,
   * validated and defaulted below. Never the live workbench's profile. */
  snapshotResourceProfile?: string | null;
  automatonId?: string | null;
  automatonName?: string | null;
  automatonNotifyMode?: "all" | "failures_only" | null;
  outcomeDismissedAt?: number | null;
  recentDismissedAt?: number | null;
  repositorySnapshotCount?: number | null;
  lastContextTokens?: number | null;
  lastContextWindow?: number | null;
  lastCompactAfterTokens?: number | null;
  createdAt: number;
  updatedAt: number;
}): ThreadSummary {
  return {
    threadId: input.id,
    kind: input.kind ?? "regular",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    provider: input.modelProvider ?? "",
    model: input.model ?? "",
    modelInputModalities: parseStoredModelInputModalities(input.modelInputModalities),
    showReasoning: input.showReasoning ?? true,
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
    readOnly: input.runtime === "legacy" || input.archivedAt != null,
    status: input.archivedAt == null ? "active" : "archived",
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    workbenchId: input.workbenchId ?? null,
    workbenchName: input.workbenchName ?? null,
    workbenchSwitchPending: input.workbenchSwitchPendingAt != null,
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
    repositorySnapshotCount: input.repositorySnapshotCount ?? 0,
    lastContextTokens: input.lastContextTokens ?? null,
    lastContextWindow: input.lastContextWindow ?? null,
    lastCompactAfterTokens: input.lastCompactAfterTokens ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
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
