import { getAgentByName } from "agents";
import type { StepContext, TurnConfig, TurnContext } from "@cloudflare/think";
import { ThinkThreadAgent, type SubagentContext } from "./think-thread-agent";
import { resolveThreadRuntimeConfigForAgent } from "./thread-agent-config";
import type { WorkProgress } from "./work-ledger";
import type { BackendReference } from "../compute/backend";
import type { UsageSource } from "./usage-recorder";

/** System-context notice injected for a subagent (see {@link SubAgent.sessionRoleContext}). */
const SUBAGENT_ROLE_PROMPT =
  "You are a subagent — a focused worker dispatched by a parent agent to complete one task and report back. " +
  "You do not have access to: spawning further subagents, manually watching background processes, or workspace integrations (MCP tools). " +
  "Use exec for shell commands. In this subagent runtime exec is synchronous: it waits until the command exits and returns stdout/stderr previews and exit status directly. You cannot manually watch or start background processes here. " +
  "When done, summarize your results clearly; your final message is delivered back to the parent.";

/**
 * How often a running subagent stamps its row in the PARENT's work ledger.
 * Comfortably inside `SUBAGENT_STALE_AFTER_MS` (3 min) so several stamps have
 * to be missed before the reaper calls a run dead.
 *
 * This is a HEARTBEAT-while-in-flight, not a stamp per completed step, and that
 * is the whole point: a subagent legitimately spends 10 minutes inside one
 * synchronous `exec` build, or one long model call, emitting nothing. Stamping
 * only at step boundaries would fault exactly that healthy run — the same
 * mistake the SDK's `noProgressBudgetMs` timer made (it is disabled in
 * subagent-config.ts for precisely this reason). Liveness here is infrastructure
 * saying "this run is in flight", which the model cannot fake or forget.
 */
const LIVENESS_STAMP_INTERVAL_MS = 30_000;

/**
 * Floor between two progress pushes from the per-step path. Matched to the
 * dock's own 5s poll: a count fresher than its only reader cannot be seen, and
 * each push is a cross-DO RPC fired from inside the tool loop.
 */
const PROGRESS_PUSH_MIN_GAP_MS = 5_000;

/**
 * A shared-sandbox subagent: a facet child of a parent {@link ThinkThreadAgent}.
 * It shares the parent class's tool-composition code, but Phase 1 gets only
 * native + sandbox + web tools — NOT full-peer parity: `onStart()` is
 * intentionally skipped (see below), so no workspace MCP tools are booted.
 * It also:
 *  - resolves identity from the parent (NOT its own facet name);
 *  - attaches to the parent's provider sandbox (never provisions/evicts);
 *  - does NOT register itself in threadIndex;
 *  - cannot spawn further subagents (depth-1) — see Task 7 for the tool gate.
 */
export class SubAgent extends ThinkThreadAgent {
  private _subagentContext?: SubagentContext;
  private _attachedRuntime?: BackendReference;
  /** Tool calls this run has made, cumulative across its steps. The number the
   *  dock shows — see {@link onStepFinish} for why it is not turns. */
  private _toolCalls = 0;
  /** When {@link pushProgressThrottled} last pushed. 0 = never, so the first
   *  tool call always publishes immediately. */
  private _lastProgressPushAt = 0;
  /**
   * The progress marker pushed to the parent alongside every liveness stamp.
   *
   * This duplicates what `reportProgress` reports, and it has to: the SDK
   * persists that call's snapshot to THIS facet's own storage, so the parent —
   * which owns the ledger the dock reads — cannot see it (`inspectAgentToolRun`
   * on the parent reads the parent's empty copy of that table). `reportProgress`
   * still drives the live run card via its broadcast; this drives the dock.
   * Both are written from {@link setProgress}, so they cannot disagree.
   */
  private _progress?: WorkProgress;
  private _livenessTimer: ReturnType<typeof setInterval> | undefined;
  /** Test seam: inject the parent context so unit tests skip the real parentAgent() facet call. */
  _testSubagentContext?: SubagentContext;

  /**
   * Stamp this run's row in the PARENT's work ledger. The ledger lives on the
   * parent's storage — a facet has its OWN storage, and a row written here
   * would be invisible to the parent's reaper — so reach back over the same
   * `parentAgent()` stub `subagentContext()` uses. This facet's NAME is the run
   * id the row is keyed by.
   *
   * Never throws and never blocks the turn: liveness is best-effort, and the
   * cost of a missed stamp is bounded (the reaper needs 3 minutes of silence).
   * The parent's `stampAlive` is a no-op on a terminal row, so a stamp racing a
   * terminal cannot resurrect a closed run.
   */
  private async stampParentAlive(): Promise<void> {
    try {
      const parent = await this.parentAgent(ThinkThreadAgent);
      await parent.stampSubagentAlive(this.name, this._progress);
    } catch {
      // Best effort: a facet/RPC failure must never break the child's turn.
    }
  }

  /**
   * Stamp now, then keep stamping until {@link stopLiveness}. Re-entrant: a new
   * turn replaces the previous timer rather than stacking a second one.
   *
   * LOAD-BEARING: this must stay bound to the TURN's lifecycle — started from
   * `beforeTurn` and stopped when the turn settles. Workers ties a timer's I/O
   * to the IoContext of the request that created it, and every tick performs
   * one (`parentAgent()` RPC). Started under `beforeTurn`, the timer's ticks run
   * inside the turn's still-open IoContext, so the RPC is legal; the settle
   * hooks clear it before that context closes.
   *
   * Move this to `onStart()` (or any other non-request seam) and it breaks
   * SILENTLY: the timer would belong to a context that is already gone, every
   * tick would throw "Cannot perform I/O on behalf of a different request",
   * `stampParentAlive` would swallow it by design, and every subagent row would
   * go stale at 3 minutes with no error anywhere. Keep start/stop on the turn.
   */
  private startLiveness(): void {
    this.stopLiveness();
    void this.stampParentAlive();
    this._livenessTimer = setInterval(
      () => void this.stampParentAlive(),
      LIVENESS_STAMP_INTERVAL_MS,
    );
  }

  private stopLiveness(): void {
    if (this._livenessTimer === undefined) return;
    clearInterval(this._livenessTimer);
    this._livenessTimer = undefined;
  }

  /** Cached pull of the parent's trusted context via the SDK facet parent stub. */
  private async subagentContext(forceRefresh = false): Promise<SubagentContext> {
    if (this._testSubagentContext) {
      this._attachedRuntime = this._testSubagentContext.attachedRuntime;
      return this._testSubagentContext;
    }
    if (!forceRefresh && this._subagentContext) return this._subagentContext;
    const parent = await this.parentAgent(ThinkThreadAgent);
    this._subagentContext = await parent.getSubagentContext();
    this._attachedRuntime = this._subagentContext.attachedRuntime;
    return this._subagentContext;
  }

  /** Identity is the PARENT's; the facet name is a run id, not a thread id. */
  override async resolveRuntimeConfigForThink() {
    const ctx = await this.subagentContext();
    const config = await resolveThreadRuntimeConfigForAgent(this.env, ctx.parentThreadId);
    if (!config) throw new Error(`subagent_parent_not_registered:${ctx.parentThreadId}`);
    return config;
  }

  /**
   * A subagent's tokens are the PARENT thread's tokens. The facet name is a run
   * id, not a thread id — billing it there would strand the spend on a row
   * nobody ever reads. The provider/model on each row come from the accumulator
   * entries (what actually served each call), not from here.
   */
  protected override async usageAttribution() {
    const ctx = await this.subagentContext();
    const config = await this.resolveRuntimeConfigForThink();
    return {
      threadId: ctx.parentThreadId,
      workspaceId: config.workspaceId,
      agentId: config.agentId,
    };
  }

  /**
   * The attribution rule: a subagent's spend is the parent's, tagged so it stays
   * distinguishable from the parent's own. ALL of it — its chat steps AND the
   * compaction its own context triggers. Without the second override a subagent's
   * compaction would land on the parent's `(thread, provider, model, 'compaction')`
   * row and be indistinguishable from a compaction the parent actually did.
   */
  protected override turnUsageSource(): UsageSource {
    return "subagent";
  }

  protected override compactionUsageSource(): UsageSource {
    return "subagent";
  }

  /** A subagent's context is not the parent thread's context — never touch the
   *  parent's `thread_index.lastContextTokens` gauge from a subagent step. */
  protected override tracksContextGauge = false;

  /** Attach to the parent's already-provisioned machine; never provision, never evict. */
  protected override attachedRuntimeForThisAgent(): BackendReference | undefined {
    return this._attachedRuntime;
  }

  /**
   * An attached subagent writes to the PARENT's machine, so its writes must
   * invalidate the PARENT's `sandbox:declared-clean` bit — the inherited
   * implementation would only clear this facet's own storage, which nothing
   * ever reads (`releaseIfIdle` no-ops in attached mode). Left un-overridden,
   * a parent that called `confirm_work_saved` before spawning keeps a bit that
   * is now a lie, and `resolveIdleDisposition` short-circuits on it and
   * DESTROYS the subagent's uncommitted work.
   *
   * Invalidating at the WRITE rather than when the run closes is the point: a
   * run can be closed by the reaper (silence, deadline) or by a crashed facet,
   * with the child never executing another line — a close-time clear is a step
   * that can be skipped, while this one is on the same path as the write it
   * describes. It also keeps the bit honest for the whole span of the run, not
   * just after it.
   *
   * Reaches the parent by thread id through `getAgentByName` rather than
   * `parentAgent()`: the bit is keyed by thread, and this path also works from
   * a rehydrated facet whose parent link was never established. Failures are
   * NOT swallowed — an exec that could not invalidate the bit is recoverable,
   * destroyed work is not.
   */
  protected override async clearSandboxDeclaredClean(): Promise<void> {
    await super.clearSandboxDeclaredClean();
    if (!this.attachedRuntimeForThisAgent()) return;
    const ctx = await this.subagentContext();
    const parent = await getAgentByName(this.env.THINK_THREAD_AGENT, ctx.parentThreadId);
    await parent.setSandboxDeclaredClean(false);
  }

  /** Depth-1: a subagent cannot spawn further subagents. */
  protected override subagentSpawnEnabled(): boolean {
    return false;
  }

  /** Subagents never register watchers (no way to surface a completion to the
   *  user; and it avoids the shared-machine eviction hazard). */
  protected override processMonitorEnabled(): boolean {
    return false;
  }

  /** A subagent thread is named by the tool that spawned it, and it never shows
   *  up in the thread list on its own -- so don't spend a model call naming it. */
  protected override autoNameEnabled(): boolean {
    return false;
  }

  /** Tell the model it is a subagent with a reduced tool set, so it doesn't
   *  waste calls on tools it lacks or start background work accidentally. */
  protected override sessionRoleContext(): { name: string; text: string } {
    return { name: "subagent-role", text: SUBAGENT_ROLE_PROMPT };
  }

  /** A rehydrated SubAgent (e.g. the alarm-driven `runSandboxEviction`, which
   *  never goes through `beforeTurn`) needs the parent's shared runtime
   *  reference cached before `attachedRuntimeForThisAgent()` is read (see H2). */
  protected override async primeAttachedContext(): Promise<void> {
    await this.subagentContext();
  }

  /** A facet must not register itself as a top-level thread. */
  override async onStart(): Promise<void> {
    // Intentionally does NOT call super.onStart() (which registers in threadIndex
    // and boots MCP for a top-level thread). A subagent inherits the parent's
    // config on demand via subagentContext().
  }

  /**
   * Cache identity + the attached sandbox id BEFORE tools compose, so
   * `sandboxHostDeps()` (consulted while building this turn's sandbox tools)
   * sees the pulled `attachedRuntimeForThisAgent()` synchronously.
   */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    // Re-enter the owner for every turn so its current compute policy validates
    // the attached runtime. Keep the result cached for the synchronous tool
    // composition performed by super.beforeTurn below.
    await this.subagentContext(true);
    // The opening marker, before any tool has run. Deliberately carries NO
    // count: `onStepFinish` owns the number, and this must not claim a unit of
    // work that has not happened.
    //
    // Set BEFORE `startLiveness()`, which stamps the parent immediately — the
    // stamp is what carries this to the dock. Today either order happens to
    // work, because `stampParentAlive` reads this field only AFTER awaiting
    // `parentAgent()`, so a later synchronous assignment still lands first;
    // this ordering is what stops that from being load-bearing. If that await
    // ever resolves synchronously (a cached stub), the reversed order would
    // send no marker at all on the first stamp — leaving the dock on "Waiting
    // for the first update" until the 30s tick.
    this.setProgress("working");
    // A step is starting: real infrastructure activity, and the start of a
    // stretch (model call + tool execution) that can legitimately be silent for
    // minutes — so hold the row alive for as long as the turn is in flight, not
    // just at this instant. `onChatResponse`/`onChatError` end it.
    this.startLiveness();
    await this.reportProgress({ phase: "working", message: "working" });
    return super.beforeTurn(ctx);
  }

  /**
   * Count the run's TOOL CALLS and publish that as its progress.
   *
   * Tool calls, not turns: a subagent gets one input and runs ONE turn, whose
   * tool loop is the entire run, so the previous per-turn counter sat at
   * "step 1" for the whole thing and only ever advanced when the turn was
   * RE-ENTERED after a recovery — i.e. it counted restarts while reading like
   * progress. Steps are where the work actually happens.
   *
   * Strictly in-memory arithmetic here, per the base override's contract: this
   * runs between every step of every tool loop, so nothing may be awaited.
   * Publication is a fire-and-forget push, rate-limited by
   * {@link PROGRESS_PUSH_MIN_GAP_MS}.
   *
   * The count lives only in memory, so a DO eviction mid-run restarts it from
   * zero and the displayed number can go DOWN once. `stampProgress` orders on
   * the timestamp rather than the count, so the fresher-but-lower value wins —
   * correct, since it is what the surviving incarnation can actually vouch for.
   */
  override onStepFinish(ctx: StepContext): void {
    // FIRST: the base override records this step's token usage, and a subagent's
    // spend is the parent thread's. Skipping it would silently drop billing.
    super.onStepFinish(ctx);
    const calls = ctx.toolCalls?.length ?? 0;
    // A step with no tool calls is the model's closing text — no new work to
    // report, and re-publishing the same count would just burn an RPC.
    if (calls === 0) return;
    this._toolCalls += calls;
    this.setProgress(`${this._toolCalls} tool call${this._toolCalls === 1 ? "" : "s"}`);
    void this.reportProgress({ phase: "working", message: this._progress?.message ?? "working" });
    this.pushProgressThrottled();
  }

  /** Single writer for {@link _progress}, so the field and its timestamp can
   *  never be set apart from each other. */
  private setProgress(message: string): void {
    this._progress = { phase: "working", message, at: Date.now() };
  }

  /**
   * Publish the current marker to the parent, at most once per
   * {@link PROGRESS_PUSH_MIN_GAP_MS}.
   *
   * Throttled because this is a cross-DO RPC on a per-step path: a tool-heavy
   * run can finish several steps a second, and the dock that reads the result
   * polls every 5s — so pushing faster than the reader reads buys nothing. The
   * 30s liveness timer is the floor either way, so the worst case without this
   * push would be a 30s-stale count, not a missing one.
   *
   * Fire-and-forget: `stampParentAlive` swallows its own failures, and awaiting
   * it here would put cross-DO latency on the tool loop's hot path.
   */
  private pushProgressThrottled(): void {
    const now = Date.now();
    if (now - this._lastProgressPushAt < PROGRESS_PUSH_MIN_GAP_MS) return;
    this._lastProgressPushAt = now;
    void this.stampParentAlive();
  }

  /** Turn settled (completed/aborted/error) — nothing is in flight, so stop
   *  claiming it is. The run's real terminal closes the row moments later; if it
   *  somehow does not, the silence from here is what lets the reaper act. */
  override async onChatResponse(result?: Parameters<ThinkThreadAgent["onChatResponse"]>[0]) {
    this.stopLiveness();
    return super.onChatResponse(result);
  }

  override onChatError(...args: Parameters<ThinkThreadAgent["onChatError"]>): unknown {
    this.stopLiveness();
    return super.onChatError(...args);
  }
}
