import type { BatchItem } from "drizzle-orm/batch";
import { eq, sql } from "drizzle-orm";
import { registryDb } from "../db/client";
import { threadIndex, threadTokenUsage } from "../db/schema";
import type { Env } from "../env";
import { log } from "../log";

export type UsageSource = "chat" | "compaction" | "auto_name" | "subagent" | "feedback";

/**
 * The subset of the AI SDK's usage we persist. Every field is optional:
 * providers omit what they don't report.
 *
 * `inputTokenDetails.cacheWriteTokens` is the VERIFIED source for cache-write
 * tokens (see Task 1's live probe against the installed `ai` package's
 * `LanguageModelUsage` type — `usage.inputTokenDetails.{noCacheTokens,
 * cacheReadTokens, cacheWriteTokens}`). `providerMetadata.anthropic
 * .cacheCreationInputTokens` remains a fallback for the native Anthropic
 * provider, which is unprobed.
 */
export interface StepUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  inputTokenDetails?:
    | {
        cacheWriteTokens?: number | undefined;
        cacheReadTokens?: number | undefined;
      }
    | undefined;
}

export interface UsageKey {
  provider: string;
  model: string;
  source: UsageSource;
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  calls: number;
}

export type UsageEntry = UsageKey & UsageTotals;

export interface ThreadUsageIds {
  threadId: string;
  workspaceId: string;
  agentId: string;
}

/**
 * Providers that report cached tokens ADDITIVELY (`inputTokens` EXCLUDES them).
 *
 * EMPTY, and that is a verified finding, not an oversight: a live probe (see the
 * "Verified usage semantics" section of the design doc) showed cached tokens are
 * INCLUDED in `inputTokens` on every provider measured. The seam stays so a future
 * probe of the native @ai-sdk/anthropic and @ai-sdk/openai providers — which are
 * still UNVERIFIED, reached only through OpenRouter so far — can add them here.
 */
const CACHED_INPUT_ADDITIVE: ReadonlySet<string> = new Set();

const num = (v: number | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/**
 * The real size of the context we sent: every input token the provider read,
 * cached or not. This is the gauge — and it drops on its own after a compaction,
 * with no special-casing.
 */
export function contextTokensFromUsage(provider: string, usage: StepUsage): number {
  const input = num(usage.inputTokens);
  const cached = num(usage.cachedInputTokens);
  return CACHED_INPUT_ADDITIVE.has(provider) ? input + cached : input;
}

/**
 * Cache-write tokens. Reads the AI SDK's normalized
 * `usage.inputTokenDetails.cacheWriteTokens` FIRST — this is the field a live
 * probe (Task 1) confirmed actually carries the value on OpenRouter-routed
 * calls. Falls back to `providerMetadata.anthropic.cacheCreationInputTokens`
 * for the native Anthropic provider, which is still unprobed.
 */
export function cacheWriteTokensFrom(usage: StepUsage, providerMetadata?: unknown): number {
  const fromUsage = usage.inputTokenDetails?.cacheWriteTokens;
  if (typeof fromUsage === "number" && Number.isFinite(fromUsage)) return fromUsage;

  if (typeof providerMetadata !== "object" || providerMetadata === null) return 0;
  const anthropic = (providerMetadata as Record<string, unknown>).anthropic;
  if (typeof anthropic !== "object" || anthropic === null) return 0;
  const raw = (anthropic as Record<string, unknown>).cacheCreationInputTokens;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

const keyOf = (k: UsageKey): string => `${k.provider} ${k.model} ${k.source}`;

/**
 * In-memory usage for ONE turn. Every method is pure arithmetic — no I/O.
 * This is what lets `onStepFinish` stay on the hot path without adding latency.
 */
export interface ContextReading {
  contextTokens: number;
  contextWindow: number;
  /** The turn's real compaction trigger. NULL when the turn didn't resolve one:
   * the client then shows no warning rather than inventing a threshold. */
  compactAfterTokens: number | null;
}

export class TurnUsageAccumulator {
  private readonly totals = new Map<string, UsageEntry>();
  private lastContext: ContextReading | null = null;

  add(key: UsageKey, usage: StepUsage, providerMetadata?: unknown): void {
    const id = keyOf(key);
    const entry = this.totals.get(id) ?? {
      ...key,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      calls: 0,
    };
    entry.inputTokens += num(usage.inputTokens);
    entry.cachedInputTokens += num(usage.cachedInputTokens);
    entry.cacheWriteTokens += cacheWriteTokensFrom(usage, providerMetadata);
    entry.outputTokens += num(usage.outputTokens);
    entry.reasoningTokens += num(usage.reasoningTokens);
    entry.calls += 1;
    this.totals.set(id, entry);
  }

  /**
   * Overwrites, never sums: the gauge is an instantaneous reading. A turn that
   * compacts mid-flight has steps before and after with wildly different input
   * sizes, and only the LAST one describes the context that now exists.
   */
  recordContext(
    provider: string,
    usage: StepUsage,
    contextWindow: number,
    compactAfterTokens?: number | undefined,
  ): void {
    this.lastContext = {
      contextTokens: contextTokensFromUsage(provider, usage),
      contextWindow,
      compactAfterTokens: typeof compactAfterTokens === "number" ? compactAfterTokens : null,
    };
  }

  isEmpty(): boolean {
    return this.totals.size === 0 && this.lastContext === null;
  }

  entries(): UsageEntry[] {
    return [...this.totals.values()];
  }

  context(): ContextReading | null {
    return this.lastContext;
  }

  /**
   * Fold another accumulator's totals into this one. Used to put a FAILED
   * flush's snapshot back so the next flush retries it — the snapshot is a
   * private object owned by that flush, so merging it back cannot double-count
   * (a failed `db.batch` is a failed transaction: nothing was written).
   *
   * The context reading is a point-in-time gauge, not a sum: a newer reading
   * already on `this` wins, and the merged-in one is only used when there is none.
   */
  merge(other: TurnUsageAccumulator): void {
    for (const e of other.entries()) {
      const id = keyOf(e);
      const entry = this.totals.get(id);
      if (!entry) {
        this.totals.set(id, { ...e });
        continue;
      }
      entry.inputTokens += e.inputTokens;
      entry.cachedInputTokens += e.cachedInputTokens;
      entry.cacheWriteTokens += e.cacheWriteTokens;
      entry.outputTokens += e.outputTokens;
      entry.reasoningTokens += e.reasoningTokens;
      entry.calls += e.calls;
    }
    if (this.lastContext === null) this.lastContext = other.context();
  }
}

/**
 * Persist ONE snapshot accumulator into D1 in a single batch: the ledger upserts
 * plus the gauge update. Called after the response is produced, never between steps.
 *
 * OWNERSHIP: `acc` must be PRIVATE to this call — the caller snapshot-and-swaps
 * before handing it over. This function never mutates or clears it, precisely so
 * that usage recorded (on the caller's live accumulator) during the D1 await
 * cannot be discarded.
 *
 * Swallows errors: losing a usage row must never fail a turn the user already paid
 * for. Returns `false` when nothing was written, so the caller can put the snapshot
 * back and retry it on the next flush.
 */
export async function flushThreadUsage(
  env: Env,
  ids: ThreadUsageIds,
  acc: TurnUsageAccumulator,
): Promise<boolean> {
  if (acc.isEmpty()) return true;
  const db = registryDb(env);
  const now = Date.now();
  const context = acc.context();

  const statements: BatchItem<"sqlite">[] = acc.entries().map((e) =>
    db
      .insert(threadTokenUsage)
      .values({
        threadId: ids.threadId,
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
        provider: e.provider,
        model: e.model,
        source: e.source,
        inputTokens: e.inputTokens,
        cachedInputTokens: e.cachedInputTokens,
        cacheWriteTokens: e.cacheWriteTokens,
        outputTokens: e.outputTokens,
        reasoningTokens: e.reasoningTokens,
        calls: e.calls,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          threadTokenUsage.threadId,
          threadTokenUsage.provider,
          threadTokenUsage.model,
          threadTokenUsage.source,
        ],
        set: {
          inputTokens: sql`${threadTokenUsage.inputTokens} + ${e.inputTokens}`,
          cachedInputTokens: sql`${threadTokenUsage.cachedInputTokens} + ${e.cachedInputTokens}`,
          cacheWriteTokens: sql`${threadTokenUsage.cacheWriteTokens} + ${e.cacheWriteTokens}`,
          outputTokens: sql`${threadTokenUsage.outputTokens} + ${e.outputTokens}`,
          reasoningTokens: sql`${threadTokenUsage.reasoningTokens} + ${e.reasoningTokens}`,
          calls: sql`${threadTokenUsage.calls} + ${e.calls}`,
          updatedAt: now,
        },
      }),
  );

  if (context) {
    statements.push(
      db
        .update(threadIndex)
        .set({
          lastContextTokens: context.contextTokens,
          lastContextWindow: context.contextWindow,
          lastCompactAfterTokens: context.compactAfterTokens,
        })
        .where(eq(threadIndex.id, ids.threadId)),
    );
  }

  try {
    if (statements.length === 1) await statements[0]!;
    else await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return true;
  } catch (error) {
    log.warn("usage_recorder.flush_failed", {
      threadId: ids.threadId,
      error: String(error),
    });
    return false;
  }
}
