import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { AttachmentRepository } from "../db/attachment-repository";
import { deleteR2PrefixBestEffort } from "../artifacts/serve";
import { ARTIFACT_TTL_MS } from "../artifacts/ttl";
import { ArtifactRepository } from "../db/artifact-repository";
import { AgentSkillRepository } from "../db/repositories/agent-skills";
import { registryBinding, registryDb } from "../db/client";
import { attachmentsBucket } from "../storage/bucket-binding";
import { computeConfigFromInputs, loadComputeConfigInputs } from "../compute/settings";
import { ThreadComputeStore } from "../compute/thread-store";
import { ThreadComputeService } from "../compute/thread-service";
import { resolveComputeEnvVars } from "../compute/env-resolve";
import { buildComputeBackend } from "../compute/registry";
import { applyComputeHostTestOverrides } from "../compute/host-test-overrides";
import { ComputeError } from "../compute/errors";
import { AgentSandboxLedger } from "../compute/agent-sandbox-ledger";
import type { DaytonaConfigurationMode } from "../compute/daytona-config";
import type { SpritesConfigurationMode } from "../compute/sprites-config";
import {
  createAgentSandboxGate,
  parseMaxActiveAgentSandboxes,
  RECLAIM_RPC_TIMEOUT_MS,
  UNLIMITED_AGENT_SANDBOXES,
  type AgentSandboxGate,
} from "../compute/agent-sandbox-quota";
import { buildComputeFileToolDefs } from "./compute-file-tools";
import type { SandboxSessionResolution } from "../compute/agent-sandbox-client";
import {
  DEFAULT_COMPUTE_ALLOWED_HOSTS,
  defaultProviderConfig,
  isComputeResourceProfile,
  needsAgentResourceProfile,
  parseDomainList,
} from "../compute/config";
import type { ComputeResourceProfile } from "../compute/backend";
import type { BackendReference, ComputeBackend } from "../compute/backend";
import type { ComputeResolvePurpose, EffectiveComputeConfig } from "../compute/types";
import type { WatcherCompletionInfo } from "./system-reminder";
import type { WorkLedgerSink } from "./work-ledger-store";
import { getGithubAppConfig } from "../github/config";
import { applyGithubToken } from "./github-token-wiring";
import { ThreadRepository } from "../db/repositories/threads";
import { AgentRepository } from "../db/repositories/agents";
import {
  probeWorkspaceCleanliness,
  type WorkspaceCleanliness,
} from "../compute/workspace-cleanliness";
import { confirmWorkSaved, type WorkSavedToolDeps } from "./work-saved-tool";

/** Guess a mime from a filename when the sandbox provider did not supply one.
 *  Only covers types we care about for chat chips (images + a few documents);
 *  everything else returns null so the caller can fall back to octet-stream. */
export function guessMimeFromFilename(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "txt":
    case "md":
    case "csv":
      return "text/plain";
    default:
      return null;
  }
}

/**
 * Everything the `AgentSandbox` Durable Object supplies so
 * {@link resolveComputeService} can construct a fully wired
 * {@link ThreadComputeService} for one thread.
 *
 * `AgentSandbox` IS THE ONLY PRODUCTION CONSTRUCTOR OF THIS TYPE, and that is
 * the invariant the whole design rests on. `storage` below is the sandbox DO's
 * own SQLite; a thread Durable Object that built one of these would create a
 * SECOND `compute_state` row, in a second DO, pointing at a second provider
 * sandbox — the model's `exec` on one machine, the eviction alarm on the other.
 * The thread DO reaches compute through `openSandboxSession`
 * (`src/compute/agent-sandbox-client.ts`) and has no way to name a store at all.
 * `test/integration/compute-owned-by-sandbox-do.integration.test.ts` asserts
 * both halves of that.
 *
 * The capabilities that live on the CONVERSATION rather than the machine
 * (system reminders, the eviction schedule, the work ledger, the child-subagent
 * lease, the "verified clean" bit) are RPC back-calls into the thread DO — see
 * `createSandboxThreadHostDeps`.
 */
export interface ComputeServiceHostDeps {
  env: Env;
  threadId: string;
  /**
   * WHOSE working directory this service runs in.
   *
   * Distinct from `threadId`, which is the ROUTING id — the thread a completion
   * reminder is delivered to, the thread a ledger row is stamped with, the
   * thread a completion token is scoped to. A `SubAgent` runs under a facet name
   * that is a RUN id: it has no `thread_index` row, no repositories of its own,
   * and no directory of its own. It is a second worker inside its PARENT's
   * checkout, so its working directory is the parent's — and reading `threadId`
   * for it would put every subagent in `/workspace/threads/<runId>`, a directory
   * `ensureWorkspaceRootOnce` dutifully CREATES and nothing ever puts code in.
   * An empty cwd, no error, no log.
   */
  workspaceThreadId: string;
  /**
   * Prepare this thread's working directory before its first command. REQUIRED
   * — see the dep of the same name on `ThreadComputeServiceDeps` for why the
   * trigger cannot be a fresh-acquire hook, and why omission here would be
   * invisible rather than loud.
   */
  ensureThreadWorkspace: () => Promise<void>;
  /** The `AgentSandbox` DO's own SQLite. See the type's doc: nothing else may supply this. */
  storage: DurableObjectStorage;
  resolveRuntimeConfig: () => Promise<{ workspaceId: string; agentId: string }>;
  /**
   * Bridges {@link ThreadComputeService}'s `setAlarm` onto the sandbox DO's own
   * `ctx.storage.setAlarm` — the machine's alarm belongs to the DO that owns the
   * machine. A Durable Object has exactly ONE alarm, which is the same
   * single-outstanding-wake shape `armAlarm`'s min-fold is built on.
   */
  scheduleEviction: (timestampMs: number) => Promise<void>;
  /** Cancels the outstanding idle-eviction alarm; used by `exec_shutdown` after teardown. */
  cancelEviction: (now: number) => Promise<void>;
  /**
   * Delivers a hidden system-reminder to the model. `"deferred"` appends it to
   * the thread's transcript history so the model sees it on the next turn
   * WITHOUT triggering one now; `"proactive"` drives a turn to surface it
   * immediately.
   *
   * When `options.watcher` is supplied the reminder is delivered as a
   * watcher-completion variant: the model still reads the same
   * `<system-reminder>` body, but the message is tagged with structured
   * metadata so the web transcript renders it as a visible completion card
   * (see {@link WatcherCompletionInfo}) instead of hiding it.
   */
  deliverSystemReminder: (input: {
    /**
     * WHICH conversation. Required, and not defaulted to `threadId` above:
     * since P3 one box serves every thread of the agent, so the thread this
     * service was resolved for and the thread a given reminder belongs to are
     * different questions. A watcher completing on thread A is delivered to A
     * even when the alarm's tick was resolved for thread B.
     */
    threadId: string;
    body: string;
    mode: "deferred" | "proactive";
    watcher?: WatcherCompletionInfo;
    /**
     * Set ONLY by the watcher-poll path, where a throw is load-bearing: it
     * leaves the work-ledger row owed so the sweep retries the delivery.
     * Command paths leave it unset and a failed delivery is swallowed. See
     * the same field on `ThreadComputeServiceDeps.deliverSystemReminder`.
     */
    mustDeliver?: boolean;
  }) => Promise<void>;
  now?: () => number;
  /**
   * Test seam: substitute the backend (e.g. the in-memory fake) instead of
   * constructing a real Daytona client from the decrypted workspace secret.
   */
  buildBackend?: (
    config: EffectiveComputeConfig,
    execEnv: Record<string, string>,
  ) => Promise<ComputeBackend>;
  /**
   * Whether this runtime can drive a PROACTIVE system-reminder turn (see
   * {@link deliverSystemReminder}). Manual watcher registration is only ever
   * surfaced via a proactive reminder on process exit, so runtimes that cannot
   * deliver proactively MUST NOT be allowed to register one — that would be a
   * silent black hole where the watch is accepted but the model is never told
   * the process finished. `true` on the Think runtime.
   */
  supportsProcessMonitor: boolean;
  /**
   * Whether exec calls may background commands after the foreground window.
   *
   * REQUIRED, and deliberately not defaulted. It used to default to
   * `!attachedRuntime`, which is NOT the value any caller wants: the real rule
   * is `supportsProcessMonitor && !attachedRuntime`, because a runtime that
   * cannot deliver a completion reminder must not background a command whose
   * finish nobody can report. The permissive default silently turned background
   * exec back ON for a caller that simply forgot the field, and typecheck said
   * nothing — it was found by hand. Making it required turns that omission into
   * a compile error.
   */
  backgroundLongRunningExec: boolean;
  /**
   * Why this service is being resolved. Omitted (i.e. `"work"`) everywhere
   * except the agent-deletion teardown, which must be able to reach a machine
   * belonging to an agent that is disabled or already archived — see
   * {@link ComputeResolvePurpose} and `resolveEffectiveComputeConfig`.
   */
  purpose?: ComputeResolvePurpose;
  /**
   * When set, the resolved service ATTACHES to this backend environment (a
   * subagent sharing its parent's machine) instead of provisioning its own.
   */
  attachedRuntime?: BackendReference;
  /**
   * Owner-side guard consulted by idle eviction / exec_shutdown so the shared
   * machine is not torn down while a child subagent holds a lease.
   */
  hasBlockingWork?: () => Promise<boolean>;
  /** Clears the "workspace verified clean" bit. Optional — see thread-service.ts. */
  markSandboxDirty?: () => Promise<void>;
  /** @internal for tests only — shrinks sync-first exec timing without waiting on real time. */
  execForegroundTimeoutMs?: number;
  /** @internal for tests only — shrinks sync-first exec polling without waiting on real time. */
  execForegroundPollIntervalMs?: number;
  /** @internal for tests only — advances fake time instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Write surface for the background work ledger (see `WorkLedgerStore`),
   * resolved PER THREAD. Threaded through so watched-process
   * registration/liveness stamps land in the ledger the reaper reads; the
   * reaper itself never touches compute.
   *
   * A router since P3, for the same reason `deliverSystemReminder` takes a
   * `threadId`: the ledger lives on the thread DO, the box serves every thread
   * of the agent, and a row belongs to the thread that started the work.
   */
  workLedgerFor?: (threadId: string) => WorkLedgerSink;
  /**
   * The ledger's next sweep horizon (`nextSweepAt` over open rows). Supplied by
   * the agent, which owns the ledger. Folded into the compute service's single
   * alarm min-fold so the reaper rides the thread's one alarm instead of
   * arming (and thereby cancelling) it.
   */
  getWorkHorizon?: (now?: number) => Promise<number | null>;
  /**
   * Fired once, after `ThreadComputeService` acquires a genuinely fresh
   * runtime (not a recovery restore). Wired to `createRepositoryPreparation`
   * so a thread's environment repos are cloned automatically; a
   * environment-less thread is a cheap no-op (no repositories to prepare).
   */
}

/**
 * Widen a compute egress allowlist with per-skill declared domains — but ONLY
 * when a restriction is already in force. A null allowlist means "unrestricted"
 * (org default applies); Daytona's domainAllowList REPLACES that default, so
 * unioning into null would silently tighten an open environment. Never do that.
 */
export function unionAllowlistWithSkillDomains(
  allowlist: string[] | null,
  skillDomains: string[],
): string[] | null {
  if (allowlist === null) return null;
  if (skillDomains.length === 0) return allowlist;
  return [...new Set([...allowlist, ...skillDomains])];
}

/**
 * The thread's environment resource profile, read LIVE, or `null` when the
 * thread has no environment (or its stored profile fails validation). Callers
 * pass this to `resolveComputeConfigForAgent` / `computeConfigFromInputs` so
 * config resolves against the environment the thread is actually assigned to
 * rather than the `small` default.
 *
 * Configuration is live: there is no per-thread snapshot any more, so editing
 * the environment's size takes effect on the next acquire.
 */
export async function readThreadAgentResourceProfile(
  env: Env,
  threadId: string,
): Promise<ComputeResourceProfile | null> {
  const db = registryDb(env);
  const agentId = (await new ThreadRepository(db).getById(threadId))?.agentId ?? null;
  if (agentId === null) return null;
  const agent = await new AgentRepository(db).getById(agentId);
  return agent && isComputeResourceProfile(agent.resourceProfile) ? agent.resourceProfile : null;
}

/**
 * Whether this thread does REPOSITORY work — the gate on the large tool-step
 * budget (see `tool-step-limit.ts`).
 *
 * It used to be "does the thread have an environment assigned", which no
 * longer distinguishes anything: every thread has an agent, and `agent_id` is
 * NOT NULL, so the old test would hand every thread the coding budget. The
 * configuration-level statement it was actually making — this thread clones
 * repositories and runs a setup script — is asked directly instead.
 *
 * Deliberately independent of {@link readThreadAgentResourceProfile}: that
 * helper returns `null` both for a missing agent and for one whose stored
 * profile fails validation, and neither means "no repository work".
 */
export async function hasThreadRepositoryWork(env: Env, threadId: string): Promise<boolean> {
  const db = registryDb(env);
  const agentId = (await new ThreadRepository(db).getById(threadId))?.agentId ?? null;
  if (agentId === null) return false;
  const repo = new AgentRepository(db);
  const [agent, repositories] = await Promise.all([
    repo.getById(agentId),
    repo.listRepositories(agentId),
  ]);
  return repositories.length > 0 || (agent?.setupScript ?? "").trim().length > 0;
}

/**
 * Resolves the effective compute config for the thread's agent and, when it is
 * enabled, builds a thread-scoped {@link ThreadComputeService} backed by the
 * DO's SQLite store. Returns `null` when compute execution is disabled or the
 * effective configuration is incomplete — callers MUST treat `null` as "no
 * compute" (hide all compute exec tools, schedule no eviction alarm).
 */
export async function resolveComputeService(hostDeps: ComputeServiceHostDeps): Promise<{
  service: ThreadComputeService;
  workspaceId: string;
  config: EffectiveComputeConfig;
} | null> {
  // Test-only substitution of the backend factory / clock / exec timing. A
  // no-op in production; see `src/compute/host-test-overrides.ts` for why it is
  // a thread-keyed module registry and not a property on the calling DO.
  const deps = applyComputeHostTestOverrides(hostDeps);
  const { workspaceId, agentId } = await deps.resolveRuntimeConfig();

  // The D1-backed config inputs (workspace/agent settings, MCP hosts, secret
  // names, credential presence) are independent of the agent's resource
  // profile, so fetch them exactly once regardless of how many times we
  // resolve below.
  const inputs = await loadComputeConfigInputs({ env: deps.env, workspaceId, agentId });
  // Resolve once with NO profile to learn whether compute is even enabled for
  // this workspace/agent, without paying for the thread's environment
  // query. The enabled/disabled decision (aside from `missing_source`, which
  // itself depends on the profile) never consults the profile — see
  // `needsAgentResourceProfile`. This is what keeps a compute-DISABLED
  // workspace from paying an extra D1 round-trip for a value it will never use.
  const preliminary = computeConfigFromInputs(inputs, null, deps.purpose);
  if (!needsAgentResourceProfile(preliminary)) return null;

  // `threadAgentId` is the thread's AGENT — what used to be a separate
  // environment bundle (repositories/env-vars/setup-script) is the agent
  // itself. Distinct from the `environmentId` local below, which names the base
  // OS image for the selected resource profile. Read LIVE from
  // `threadIndex.agentId`: the per-thread snapshot is gone, because a shared
  // box cannot honour a per-thread config version. Fetched ONLY once we know
  // compute could actually be enabled (see above), so this query is paid
  // exactly once and never on the disabled path.
  //
  // `agentId` is NOT NULL, so there is no "no environment" case here — but the
  // row lookup can still miss, and the null-guards below are kept for exactly
  // that.
  const threadAgentId =
    (await new ThreadRepository(registryDb(deps.env)).getById(deps.threadId))?.agentId ?? null;
  // One read serves both the profile and the env-vars/allowlist below.
  const agentRow = threadAgentId
    ? ((await new AgentRepository(registryDb(deps.env)).getById(threadAgentId)) ?? null)
    : null;
  const agentResourceProfile =
    agentRow && isComputeResourceProfile(agentRow.resourceProfile)
      ? agentRow.resourceProfile
      : null;

  const config = computeConfigFromInputs(inputs, agentResourceProfile, deps.purpose);
  if (!config.enabled) return null;

  const skillDomains = await new AgentSkillRepository(registryDb(deps.env)).listEnabledSkillDomains(
    {
      workspaceId,
      agentId,
    },
  );

  const store = new ThreadComputeStore(deps.storage, config.value.limits);
  store.migrate();
  const computeState = store.getComputeState();
  // Prefer the profile persisted on state so the backend is built for the
  // environment source the LIVE sandbox was actually acquired under — but ONLY
  // while such a sandbox exists.
  //
  // This gate is load-bearing. `markAcquiring` writes the resolved profile into
  // `compute_state` and `markAbsent` preserves it, so an unconditional
  // preference means the profile frozen at the very FIRST acquire wins forever:
  // retarget the thread to a medium environment and every later sandbox still
  // provisions small, from small's base image. The switch handshake used to
  // paper over that with an explicit "adopt the committed profile" write; that
  // handshake is gone, and configuration is live, so the correct rule is that a
  // stored profile only outranks config while there is a runtime to stay
  // consistent with. Same rule in `ThreadComputeService.readOrAcquireRuntime`.
  const hasRuntime = computeState?.status === "active" || computeState?.status === "recoverable";
  const effectiveProfile =
    (hasRuntime ? computeState?.resourceProfile : null) ?? config.value.resourceProfile;

  // Agent-level allowlist additions, applied additively on top of the workspace
  // list. A Daytona agent can also activate restrictions itself; that path must
  // restore enabled MCP hosts that the unrestricted workspace resolution
  // intentionally left out.
  //
  // The env-vars and secret NAMES that used to be gathered here as a separate
  // "environment" layer are gone from this function, not defaulted to empty:
  // they now arrive through `config.agentEditableEnv` / `config.secretEnvNames`
  // (see `loadComputeConfigInputs`), which read the same agent row. Collecting
  // them twice would have put the same values in two precedence slots.
  const agentNetworkHosts = agentRow ? parseDomainList(agentRow.sandboxNetworkDomainAllowlist) : [];

  const baseAllowlist =
    config.value.provider === "daytona" &&
    config.value.allowedHosts === null &&
    agentNetworkHosts.length > 0
      ? DEFAULT_COMPUTE_ALLOWED_HOSTS
      : config.value.allowedHosts;
  const widenedAllowlist = unionAllowlistWithSkillDomains(baseAllowlist, [
    ...inputs.mcpHosts,
    ...skillDomains,
    ...agentNetworkHosts,
  ]);

  const effectiveConfig: EffectiveComputeConfig = {
    ...config.value,
    allowedHosts: widenedAllowlist,
    resourceProfile: effectiveProfile,
  };
  const existingReference =
    computeState?.status === "active" && computeState.runtimeRef
      ? computeState.runtimeRef
      : computeState?.status === "recoverable" && computeState.recoveryRef
        ? computeState.recoveryRef
        : null;
  if (existingReference) {
    const storedProviderConfig =
      computeState?.providerConfig?.kind === existingReference.provider
        ? computeState.providerConfig
        : existingReference.provider !== effectiveConfig.provider
          ? defaultProviderConfig(existingReference.provider)
          : effectiveConfig.providerConfig;
    effectiveConfig.provider = existingReference.provider;
    effectiveConfig.providerConfig = storedProviderConfig;
  }

  const environmentSource =
    effectiveConfig.providerConfig.kind === "daytona"
      ? effectiveConfig.providerConfig.profiles[effectiveProfile]
      : null;
  const environmentId = environmentSource
    ? environmentSource.value
    : `${effectiveConfig.provider}:${effectiveProfile}`;

  const now = deps.now ?? (() => Date.now());
  // The environment is resolved BEFORE the backend is constructed, because the
  // sprites backend has to carry it on every exec (its create-time
  // `environment` never reaches a command) and so needs it at construction.
  // Nothing in this resolution depends on the backend.
  const computeEnv = await resolveComputeEnvVars({
    env: deps.env,
    workspaceId,
    agentId,
    config: effectiveConfig,
  });
  // Populate GH_TOKEN from a GitHub App installation when configured and unset.
  let effectiveEnv = computeEnv;
  const githubConfig = getGithubAppConfig(deps.env);
  if (githubConfig) {
    // LIVE repository list for the thread's AGENT — the token is minted for
    // whatever it currently declares, not a frozen snapshot. Same key as every
    // other repository read: `thread.agentId`.
    const repositories = threadAgentId
      ? await new AgentRepository(registryDb(deps.env)).listRepositories(threadAgentId)
      : [];
    effectiveEnv = await applyGithubToken({
      db: registryDb(deps.env),
      workspaceId,
      config: githubConfig,
      existingEnv: computeEnv,
      repoUrls: repositories.map((r) => r.url),
      log: (message) => console.log(message),
    });
  }
  const backend = deps.buildBackend
    ? await deps.buildBackend(effectiveConfig, effectiveEnv)
    : await buildComputeBackend(
        deps.env,
        workspaceId,
        deps.threadId,
        effectiveConfig,
        undefined,
        effectiveEnv,
      );
  const quota = buildAgentSandboxGate({
    env: deps.env,
    effectiveConfig,
    daytonaMode: inputs.daytonaConfiguration?.mode ?? null,
    spritesMode: inputs.spritesConfiguration?.mode ?? null,
    workspaceId,
    agentId,
    backend,
    now,
  });
  const service = new ThreadComputeService({
    backend,
    store,
    config: effectiveConfig,
    environmentId,
    threadId: deps.threadId,
    env: effectiveEnv,
    // The Worker's own origin/secret (NOT `effectiveEnv` above, the sandbox's
    // exec environment) — see `ThreadComputeServiceDeps.appBaseUrl`'s doc.
    appBaseUrl: deps.env.APP_BASE_URL,
    betterAuthSecret: deps.env.BETTER_AUTH_SECRET,
    setAlarm: (timestamp) => deps.scheduleEviction(timestamp),
    clearAlarm: (alarmNow) => deps.cancelEviction(alarmNow),
    now,
    deliverSystemReminder: deps.deliverSystemReminder,
    supportsProcessMonitor: deps.supportsProcessMonitor,
    backgroundLongRunningExec: deps.backgroundLongRunningExec,
    ...(deps.attachedRuntime ? { attachedRuntime: deps.attachedRuntime } : {}),
    ...(quota ? { quota } : {}),
    ...(deps.hasBlockingWork ? { hasBlockingWork: deps.hasBlockingWork } : {}),
    ...(deps.markSandboxDirty ? { markSandboxDirty: deps.markSandboxDirty } : {}),
    ...(deps.execForegroundTimeoutMs !== undefined
      ? { execForegroundTimeoutMs: deps.execForegroundTimeoutMs }
      : {}),
    ...(deps.execForegroundPollIntervalMs !== undefined
      ? { execForegroundPollIntervalMs: deps.execForegroundPollIntervalMs }
      : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.workLedgerFor ? { workLedgerFor: deps.workLedgerFor } : {}),
    ...(deps.getWorkHorizon ? { getWorkHorizon: deps.getWorkHorizon } : {}),
    ensureThreadWorkspace: deps.ensureThreadWorkspace,
    workspaceThreadId: deps.workspaceThreadId,
  });
  return { service, workspaceId, config: effectiveConfig };
}

/**
 * Does this provider's capacity come out of OUR budget, and therefore need the
 * per-workspace ledger cap?
 *
 * - **Cloudflare** — always. The containers run on the deployment's account.
 * - **Daytona, system-managed** — yes. It bills the operator's
 *   `DAYTONA_API_KEY`, so an uncapped workspace spends our money exactly the
 *   way an uncapped Cloudflare one does. This was previously exempt on the
 *   reasoning that "Daytona has its own provider-side capacity" — true, but
 *   that capacity is the operator's, and Daytona is now what new workspaces are
 *   provisioned with (`DEFAULT_SANDBOX_PROVIDER`), so the exemption would leave
 *   every new account unbounded.
 * - **Daytona, BYOK** — no. The workspace supplies its own key and pays its own
 *   provider directly; capping that would be us rationing someone else's
 *   account. This is the case the original exemption is still right about.
 * - **Sprites, system-managed** — yes, same reasoning as system-managed
 *   Daytona: it spends the operator's Fly plan concurrency.
 * - **Sprites, BYOK** — no. Same BYOK exemption rationale as Daytona applies
 *   verbatim: the workspace supplies its own key and pays its own provider.
 *
 * Kept pure and exported so the rule is directly assertable, rather than only
 * observable by driving the whole resolution pipeline (DB-backed settings,
 * secrets, MCP host lookups) end to end.
 */
export function isQuotaGatedProvider(
  provider: EffectiveComputeConfig["provider"],
  daytonaMode: DaytonaConfigurationMode | null,
  spritesMode: SpritesConfigurationMode | null,
): boolean {
  if (provider === "cloudflare") return true;
  if (provider === "daytona") return daytonaMode === "system";
  if (provider === "sprites") return spritesMode === "system";
  return false;
}

/**
 * Builds the agent's ledger row writer and, for the providers that spend the
 * operator's capacity, its per-workspace cap — see {@link isQuotaGatedProvider}.
 *
 * ALWAYS returns a gate, never `undefined`, and that changed with P3. The old
 * quota gate existed only to refuse; this one also RECORDS which provider-side
 * machine an agent owns, and that record is what keeps the orphan reconciler
 * from deleting it. Skipping the gate for an unrationed provider would have
 * made every BYOK box invisible to the ledger. A provider we do not ration
 * gets {@link UNLIMITED_AGENT_SANDBOXES} instead of no gate at all.
 *
 * Split out from {@link resolveComputeService} so the limit rule is testable
 * on its own.
 */
export function buildAgentSandboxGate(input: {
  env: Env;
  effectiveConfig: EffectiveComputeConfig;
  /** The workspace's resolved Daytona mode; null when it is not a Daytona workspace. */
  daytonaMode: DaytonaConfigurationMode | null;
  /** The workspace's resolved Sprites mode; null when it is not a Sprites workspace. */
  spritesMode: SpritesConfigurationMode | null;
  workspaceId: string;
  agentId: string;
  backend: ComputeBackend;
  now: () => number;
}): AgentSandboxGate {
  const rationed = isQuotaGatedProvider(
    input.effectiveConfig.provider,
    input.daytonaMode,
    input.spritesMode,
  );
  return createAgentSandboxGate({
    ledger: new AgentSandboxLedger(registryBinding(input.env)),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    provider: input.effectiveConfig.provider,
    limit: rationed
      ? parseMaxActiveAgentSandboxes(input.env.MAX_ACTIVE_AGENT_SANDBOXES_PER_WORKSPACE)
      : UNLIMITED_AGENT_SANDBOXES,
    externalRuntimeId: (runtime) => input.backend.externalRuntimeId(runtime),
    now: input.now,
    reclaim: (agentId) => reclaimAgentSandbox(input.env, agentId),
  });
}

/**
 * Ask another AGENT's sandbox DO to put its box to sleep.
 *
 * Addressed to `AGENT_SANDBOX` by agent id, not to a thread DO: since P3 the
 * machine belongs to the agent, and there is no single thread that speaks for
 * it. The DO answers from the session inputs its last `session()` open
 * recorded — the same record the alarm replays — so a box that has never been
 * opened simply refuses.
 *
 * A reclaim only ever RELEASES (hibernate, or snapshot-and-stop). It must never
 * reach a destroy: the caller wants a concurrency slot, not another agent's
 * filesystem.
 *
 * Time-boxed: a DO is single-threaded, so a target mid-turn would otherwise
 * make the caller wait behind its queue. A timeout is just a refusal.
 */
async function reclaimAgentSandbox(env: Env, agentId: string): Promise<boolean> {
  const stub = env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentId)) as unknown as {
    releaseIfReclaimableForAgent: () => Promise<boolean>;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), RECLAIM_RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([stub.releaseIfReclaimableForAgent(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface ComputeFileContext {
  env: Env;
  threadId: string;
  workspaceId: string;
}

/** Status peeks allowed per process per turn before exec_output refuses. */
export const EXEC_OUTPUT_PEEK_LIMIT = 2;

/**
 * Whether this exec_output call should refuse. Only a WATCHED, still-RUNNING
 * process can be refused: a notification is guaranteed for it, so polling adds
 * nothing. An unwatched process (no notification coming) and an exited one
 * (reading final output) always read freely, so a legitimate one-off peek
 * never hits this.
 */
export function shouldRefusePeek(input: {
  peeksThisTurn: number;
  isWatched: boolean;
  isRunning: boolean;
}): boolean {
  if (!input.isWatched || !input.isRunning) return false;
  return input.peeksThisTurn >= EXEC_OUTPUT_PEEK_LIMIT;
}

export function toErrorResult(error: unknown): { ok: false; error: string; detail?: string } {
  if (error instanceof ComputeError) {
    return { ok: false, error: error.code, detail: error.message };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Builds the AI SDK `tool()` definitions for the compute exec surface. Split out
 * from {@link createComputeTools} so the tool schemas + delegation wiring can be
 * unit-tested with a stub service, independent of config/backend resolution.
 * `getFileContext` is resolved lazily (upload/download need the workspace id).
 */
/**
 * The compute surface the model-facing exec tools actually call.
 *
 * A `Pick` rather than `ThreadComputeService` itself for the same reason
 * `ComputeFileToolTarget` is one: post-cutover the tools run on the THREAD
 * Durable Object and hold a `SandboxSessionClient` — a structural stand-in for
 * a service that lives in another DO — and `ThreadComputeService` has private
 * fields, so TypeScript types it NOMINALLY and no stand-in is ever assignable
 * to it. Naming the methods keeps the tools honest without a cast: add a call
 * the session does not forward and this list, not a runtime failure, is what
 * says so.
 */
export type ComputeExecToolTarget = Pick<
  ThreadComputeService,
  | "exec"
  | "execList"
  | "execOutput"
  | "execOutputGrep"
  | "execOutputRead"
  | "execStop"
  | "execShutdown"
  | "execUploadFile"
  | "execDownloadFile"
  | "execPublishArtifact"
  | "listActiveWatchersView"
>;

export interface BuildComputeToolDefsOptions {
  networkDomainAllowlist?: string[] | null;
  secretEnvVarNames?: string[];
  envVarNames?: string[];
  supportsProcessMonitor?: boolean;
  backgroundLongRunningExec?: boolean;
  attachedRuntime?: BackendReference | undefined;
  workSaved?: WorkSavedToolDeps | undefined;
}

export function buildComputeToolDefs(
  getService: () => Promise<ComputeExecToolTarget>,
  getFileContext: () => Promise<ComputeFileContext>,
  options: BuildComputeToolDefsOptions = {},
): ToolSet {
  const {
    networkDomainAllowlist = null,
    secretEnvVarNames = [],
    envVarNames = [],
    supportsProcessMonitor = false,
    attachedRuntime,
    backgroundLongRunningExec = !attachedRuntime,
    workSaved,
  } = options;
  const netNote =
    networkDomainAllowlist && networkDomainAllowlist.length
      ? ` Outbound network is restricted to an allowlist; reachable hosts include: ${networkDomainAllowlist.slice(0, 30).join(", ")}${networkDomainAllowlist.length > 30 ? ", …" : ""}. Other hosts are blocked.`
      : "";
  const presetNames = [...new Set([...envVarNames, ...secretEnvVarNames])].sort();
  const envNote = presetNames.length
    ? ` Preset environment variables are available to every command: ${presetNames.slice(0, 30).join(", ")}${presetNames.length > 30 ? ", …" : ""}.`
    : "";
  const backgroundNote = supportsProcessMonitor
    ? "If it is still running after 10 seconds, it is backgrounded and the harness attempts to attach a watcher automatically. The returned result indicates whether watching was attached. When watching is true and no independent work remains, end your turn instead of polling: the command reports its own completion to this thread when it exits, usually within a second or two, and a 60-second sweep is only a fallback for a report that never arrives. Polling therefore cannot tell you anything sooner than being told will."
    : "If it is still running after 10 seconds, it is backgrounded without a watcher in this runtime. Do not busy-poll just to wait; if no independent work remains, report that it is still running/backgrounded and stop. Use exec_output only for one-off current output inspection or truncated previews.";
  const execTimingNote = !backgroundLongRunningExec
    ? attachedRuntime
      ? "This attached subagent runtime runs exec synchronously: it waits until the command exits and does not background long-running commands."
      : "Exec runs synchronously in this runtime: it waits until exit and does not background long-running commands."
    : `Wait up to 10 seconds for completion; if it finishes, stdout/stderr previews and exit status are returned directly. ${backgroundNote}`;
  const timeoutNote =
    " Omit timeoutMs unless intentionally capping runtime; if set, it must be at least as long as the command is expected to take.";
  // Per-process peek counter for the exec_output anti-poll refusal. Scoped to
  // this closure — NOT module-level — so it is naturally per-turn and
  // per-thread: `createComputeTools` (and this function) is called fresh from
  // `beforeTurn` every turn, on a per-DO-instance service, so a fresh Map here
  // is both "resets each turn" and "never leaks across threads" for free,
  // with no explicit reset call needed. A per-step reset would never let the
  // limit bite (every peek reads as step 0); a module-global counter would
  // refuse one thread's reads because another thread's peeks incremented it.
  const execOutputPeeksThisTurn = new Map<string, number>();
  return {
    exec: tool({
      description: `Run a shell command in this thread's isolated code sandbox. ${execTimingNote}${timeoutNote}${netNote}${envNote}`,
      inputSchema: z.object({
        command: z.string().describe("Shell command to run."),
        cwd: z.string().optional().describe("Working directory inside the sandbox."),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum wall-clock runtime in milliseconds. Omit unless intentionally capping runtime; if set, it must be at least as long as the command is expected to take, e.g. sleep 90 needs timeoutMs >= 90000.",
          ),
        label: z.string().optional().describe("Optional human-readable label."),
      }),
      execute: async (input) => {
        try {
          return await (await getService()).exec(input);
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_output: tool({
      description: `Read bounded recent output and live status for a sandbox process. It does NOT wait: it reports current status immediately and never returns full output. A message is delivered to this thread automatically when a background process finishes — if you have nothing else to do, end your turn instead of calling this. Use it only for a one-off status/output peek, never in a loop. A watched, still-running process allows at most ${EXEC_OUTPUT_PEEK_LIMIT} status peeks per turn — further calls are refused (without contacting the sandbox) since the completion notification is automatic. Unwatched and already-finished processes are never limited.`,
      inputSchema: z.object({
        processId: z.string(),
        maxLines: z.number().int().positive().optional(),
        maxBytes: z.number().int().positive().optional(),
        // No "both": stdout/stderr are independently-indexed chunk streams with
        // no reliable global ordering, so a combined tail can't be assembled
        // correctly. Use exec_output_grep (merges by line number) for both.
        stream: z.enum(["stdout", "stderr"]).optional(),
      }),
      execute: async (input) => {
        try {
          const service = await getService();
          // Read-only view over the live watcher registry (no backend call):
          // a process only appears here if it is actually being watched, and
          // its `status` is the store's locally-known value, not a fresh
          // provider read. That is exactly what lets the refusal below decide
          // without ever touching the backend.
          const watchers = await service.listActiveWatchersView();
          const watcherEntry = watchers.find((w) => w.processId === input.processId);
          const isWatched = Boolean(watcherEntry);
          const isRunning = watcherEntry?.status === "running";
          const peeksThisTurn = execOutputPeeksThisTurn.get(input.processId) ?? 0;
          if (shouldRefusePeek({ peeksThisTurn, isWatched, isRunning })) {
            return {
              ok: false as const,
              refused: true as const,
              processId: input.processId,
              message: `Process ${input.processId} is being watched — you will be notified automatically when it finishes, with its output. You have already checked it ${peeksThisTurn} times this turn. Stop checking and end your turn; if you have other independent work, do that instead.`,
            };
          }
          execOutputPeeksThisTurn.set(input.processId, peeksThisTurn + 1);
          return await service.execOutput(input);
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_output_grep: tool({
      description: "Search stored stdout/stderr for a sandbox process with hard result limits.",
      inputSchema: z.object({
        processId: z.string(),
        pattern: z.string(),
        stream: z.enum(["stdout", "stderr", "both"]).optional(),
        caseSensitive: z.boolean().optional(),
        contextLines: z.number().int().nonnegative().optional(),
        maxMatches: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        try {
          return await (await getService()).execOutputGrep(input);
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_output_read: tool({
      description: "Read a bounded line or byte range from stored sandbox process output.",
      inputSchema: z.object({
        processId: z.string(),
        stream: z.enum(["stdout", "stderr"]).optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        startByte: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        try {
          return await (await getService()).execOutputRead(input);
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_stop: tool({
      description: "Stop a sandbox process.",
      inputSchema: z.object({
        processId: z.string(),
        mode: z.enum(["interrupt", "terminate", "kill"]).optional(),
      }),
      execute: async (input) => {
        try {
          return await (await getService()).execStop(input);
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_shutdown: tool({
      description:
        "Shut down and delete this thread's code sandbox entirely, freeing its resources. Use when the sandbox is no longer needed. Idempotent — safe to call when no sandbox exists. If any process is still running, the call is refused and returns the running processes unless you pass confirm: true (running processes will be killed). After shutdown, a future exec transparently starts a fresh sandbox.",
      inputSchema: z.object({
        confirm: z
          .boolean()
          .optional()
          .describe("Set true to proceed when processes are still running (they will be killed)."),
      }),
      execute: async (input) => {
        try {
          return await (await getService()).execShutdown(input);
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_list: tool({
      description:
        "List running and recent sandbox processes for this thread. Use it for a one-off overview, never in a loop: a completion message is delivered to this thread automatically when a background process finishes, usually within a second or two, so if you have nothing else to do, end your turn instead of listing repeatedly. If you have a specific reason to check anyway, leave at least 60 seconds between checks — the fallback sweep runs on a 60-second cycle, so listing more often cannot reveal anything new.",
      inputSchema: z.object({
        status: z.enum(["running", "exited", "failed", "stopped", "all"]).optional(),
        limit: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        try {
          // Status filtering + limit ordering lives in the service so the status
          // filter is applied BEFORE the limit (avoids under-returning).
          return await (await getService()).execList(input);
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_upload_file: tool({
      description: "Upload an attached Nadi file into the sandbox.",
      inputSchema: z.object({
        sourceAttachmentId: z.string(),
        destinationPath: z.string(),
        overwrite: z.boolean().optional(),
      }),
      execute: async (input) => {
        try {
          const { env, threadId } = await getFileContext();
          const row = await new AttachmentRepository(registryBinding(env)).getByIdInThread(
            input.sourceAttachmentId,
            threadId,
          );
          if (!row) throw new Error("sandbox_upload_source_not_found");
          const object = await attachmentsBucket(env).get(row.r2Key);
          if (!object) throw new Error("sandbox_upload_source_not_found");
          const bytes = await object.arrayBuffer();
          return await (
            await getService()
          ).execUploadFile({
            destinationPath: input.destinationPath,
            bytes,
            ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
          });
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_download_file: tool({
      description:
        "Download a sandbox file into Nadi-managed storage and attach it for the user (images open in a lightbox). Use for non-HTML deliverables — charts, screenshots, PDFs, data exports — or when the user explicitly wants a downloadable file. Do NOT use this for HTML the user should view in a browser; use exec_publish_artifact instead (downloaded HTML is plain text and will not render).",
      inputSchema: z.object({
        path: z.string(),
        artifactName: z.string().optional(),
        maxBytes: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        try {
          const { env, threadId, workspaceId } = await getFileContext();
          const download = await (
            await getService()
          ).execDownloadFile({
            path: input.path,
            maxBytes: input.maxBytes ?? 10_000_000,
          });
          const attachmentId = `att_${crypto.randomUUID()}`;
          const filename =
            input.artifactName ?? download.filename ?? input.path.split("/").pop() ?? attachmentId;
          const mimeType =
            download.mimeType ?? guessMimeFromFilename(filename) ?? "application/octet-stream";
          const r2Key = `${workspaceId}/${threadId}/${attachmentId}`;
          await attachmentsBucket(env).put(r2Key, download.bytes);
          await new AttachmentRepository(registryBinding(env)).insert({
            id: attachmentId,
            workspaceId,
            threadId,
            mimeType,
            filename,
            byteSize: download.bytes.byteLength,
            r2Key,
            status: "committed",
            createdAt: Date.now(),
          });
          return {
            attachmentId,
            filename,
            byteSize: download.bytes.byteLength,
            mimeType,
            url: `/api/attachments/${attachmentId}`,
          };
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    exec_publish_artifact: tool({
      description:
        "Publish a sandbox directory as an ephemeral HTML preview artifact. The chat UI offers Preview / Open so the user can view a real page with working relative assets. Prefer this over exec_download_file for any HTML the user should open in a browser — including a single .html file (pass its parent directory as path and the filename as entryPath). Default entryPath is index.html.",
      inputSchema: z.object({
        path: z.string(),
        entryPath: z.string().optional(),
        title: z.string().optional(),
        maxBytes: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        try {
          const { env, threadId, workspaceId } = await getFileContext();
          const published = await (
            await getService()
          ).execPublishArtifact({
            path: input.path,
            ...(input.entryPath === undefined ? {} : { entryPath: input.entryPath }),
            ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
          });
          const artifactId = `art_${crypto.randomUUID()}`;
          const r2Prefix = `artifacts/${artifactId}/`;
          try {
            for (const f of published.files) {
              await attachmentsBucket(env).put(r2Prefix + f.relativePath, f.bytes, {
                httpMetadata: { contentType: f.mimeType },
              });
            }
            const createdAt = Date.now();
            const expiresAt = createdAt + ARTIFACT_TTL_MS;
            const entryPath = input.entryPath ?? "index.html";
            const title = input.title ?? input.path.split("/").filter(Boolean).pop() ?? artifactId;
            await new ArtifactRepository(registryBinding(env)).insert({
              id: artifactId,
              workspaceId,
              threadId,
              title,
              entryPath,
              fileCount: published.files.length,
              byteSize: published.totalBytes,
              r2Prefix,
              status: "active",
              expiresAt,
              createdAt,
            });
            return {
              artifactId,
              title,
              entryPath,
              fileCount: published.files.length,
              byteSize: published.totalBytes,
              expiresAt,
              url: `/api/artifacts/${artifactId}`,
            };
          } catch (error) {
            // Puts-then-insert can leave unreachable R2 objects; reclaim the prefix.
            await deleteR2PrefixBestEffort(attachmentsBucket(env), r2Prefix);
            throw error;
          }
        } catch (error) {
          return toErrorResult(error);
        }
      },
    }),
    ...(workSaved && !attachedRuntime
      ? {
          confirm_work_saved: tool({
            description:
              "Declare that all work in the sandbox is committed and pushed. The workspace is checked before the declaration is accepted: if any repository has uncommitted changes or unpushed commits, the call is refused and the offending paths are returned. Call this when you have finished working and everything is saved.",
            inputSchema: z.object({}),
            execute: async () => {
              try {
                return await confirmWorkSaved(workSaved);
              } catch (error) {
                return toErrorResult(error);
              }
            },
          }),
        }
      : {}),
  };
}

/**
 * What the THREAD Durable Object supplies when it builds the model-facing
 * compute tools. Deliberately not {@link ComputeServiceHostDeps}: the service
 * is already resolved, in the sandbox DO, and everything left here is either
 * plain data or a capability that belongs to the conversation.
 *
 * Note what is absent: `storage`. The tool layer has no store and cannot make
 * one — see {@link ComputeServiceHostDeps}.
 */
export interface ComputeToolDeps {
  env: Env;
  threadId: string;
  /** See {@link ComputeServiceHostDeps.supportsProcessMonitor}. Caller-stated; no default. */
  supportsProcessMonitor: boolean;
  /** See {@link ComputeServiceHostDeps.backgroundLongRunningExec}. Caller-stated; no default. */
  backgroundLongRunningExec: boolean;
  /** Present when this thread is an attached subagent sharing its parent's machine. */
  attachedRuntime?: BackendReference;
  /** Sets/clears the "workspace verified clean" bit; backs `confirm_work_saved`. */
  setSandboxDeclaredClean?: (clean: boolean) => Promise<void>;
}

/**
 * Async, config-aware factory for the native compute exec tools, over a session
 * the caller has already opened on the thread's `AgentSandbox`.
 *
 * `session === null` means compute is disabled or incomplete for the thread, and
 * the answer is an EMPTY tool set: the runtime hides all compute exec tools from
 * the model (design spec: the model must not see tools guaranteed to fail
 * because no compute backend is configured).
 *
 * The session is passed IN rather than opened here because `beforeTurn` already
 * opens one for the turn, and resolving costs several D1 reads plus a GitHub App
 * token mint. Opening a second one per turn would pay all of it twice.
 */
export async function createComputeTools(
  session: SandboxSessionResolution | null,
  toolDeps: ComputeToolDeps,
): Promise<ToolSet> {
  const resolved = session;
  if (!resolved) return {};
  // Same test-only substitution `resolveComputeService` applies — repeated
  // here rather than only through the resolved service.
  //
  // BELOW the null-session return, deliberately. Applied above it, a test whose
  // session resolves to `null` would stamp `CONSUMED` from this factory alone —
  // and the guard exists to make a BYPASSED registry fail loudly, so deleting
  // `resolveComputeService`'s own `applyComputeHostTestOverrides` call would
  // then still leave every such test green. A call that returns an empty tool
  // set consumed nothing; it must not say it did.
  const deps = applyComputeHostTestOverrides(toolDeps);
  const { supportsProcessMonitor, backgroundLongRunningExec, attachedRuntime } = deps;
  const execTools = buildComputeToolDefs(
    async () => resolved.service,
    async () => ({ env: deps.env, threadId: deps.threadId, workspaceId: resolved.workspaceId }),
    {
      networkDomainAllowlist: resolved.config.allowedHosts,
      secretEnvVarNames: resolved.config.secretEnvNames,
      envVarNames: Object.keys(resolved.config.editableEnv),
      supportsProcessMonitor,
      backgroundLongRunningExec,
      attachedRuntime,
      // Gated on `!attachedRuntime`: an attached subagent shares the parent's
      // runtime, so letting it declare the parent's sandbox discardable would
      // destroy the parent's
      // work. `resolved.service` is already resolved for THIS runtime (the
      // subagent's own attached environment when attached, the owner's
      // otherwise), so gating registration is the only seam that matters.
      workSaved:
        !attachedRuntime && deps.setSandboxDeclaredClean
          ? {
              probe: async () =>
                probeWorkspaceCleanliness((command, timeoutMs) =>
                  resolved.service.execRun({ command, timeoutMs, label: "workspace cleanliness" }),
                ),
              setDeclaredClean: deps.setSandboxDeclaredClean,
              threadId: deps.threadId,
            }
          : undefined,
    },
  );
  // Model-native file tools share the same lease/runtime resolution as exec and
  // are exposed only when compute is enabled (this factory returns {} above when
  // it is not).
  const fileTools = buildComputeFileToolDefs(async () => resolved.service.files);
  return { ...execTools, ...fileTools };
}
