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
import { ContainerLedger } from "../compute/container-ledger";
import type { DaytonaConfigurationMode } from "../compute/daytona-config";
import type { SpritesConfigurationMode } from "../compute/sprites-config";
import {
  createComputeQuotaGate,
  parseMaxActiveContainers,
  RECLAIM_RPC_TIMEOUT_MS,
  type ComputeQuotaGate,
} from "../compute/container-quota";
import { buildComputeFileToolDefs } from "./compute-file-tools";
import type { SandboxSessionResolution } from "../compute/agent-sandbox-client";
import {
  DEFAULT_COMPUTE_ALLOWED_HOSTS,
  defaultProviderConfig,
  isComputeResourceProfile,
  needsWorkbenchResourceProfile,
  parseDomainList,
} from "../compute/config";
import type { ComputeResourceProfile } from "../compute/backend";
import type { BackendReference, ComputeBackend } from "../compute/backend";
import type { EffectiveComputeConfig } from "../compute/types";
import type { WatcherCompletionInfo } from "./system-reminder";
import type { WorkLedgerSink } from "./work-ledger-store";
import { getGithubAppConfig } from "../github/config";
import { applyGithubToken } from "./github-token-wiring";
import { ThreadRepositorySnapshotRepository } from "../db/repositories/thread-repository-snapshots";
import { ThreadRepository } from "../db/repositories/threads";
import { WorkbenchRepository } from "../db/repositories/workbenches";
import { ComputeEnvSecretsStore } from "../compute/env-secrets";
import { parseEnvVarsJson } from "../compute/env-vars";
import { createWorkspaceSecretsServices } from "../secrets";
import { commitWorkbenchSwitchIfPending } from "./workbench-switch-commit";
import { log } from "../log";
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
  /** The `AgentSandbox` DO's own SQLite. See the type's doc: nothing else may supply this. */
  storage: DurableObjectStorage;
  resolveRuntimeConfig: () => Promise<{ workspaceId: string; agentId: string }>;
  /** Bridges {@link ThreadComputeService}'s `setAlarm` onto the Agents SDK scheduler. */
  scheduleEviction: (timestampMs: number) => Promise<void>;
  /** Cancels the outstanding idle-eviction alarm; used by `exec_shutdown` after teardown. */
  cancelEviction: () => Promise<void>;
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
  deliverSystemReminder: (
    body: string,
    mode: "deferred" | "proactive",
    options?: {
      watcher?: WatcherCompletionInfo;
      /**
       * Set ONLY by the watcher-poll path, where a throw is load-bearing: it
       * leaves the work-ledger row owed so the sweep retries the delivery.
       * Command paths leave it unset and a failed delivery is swallowed. See
       * the same field on `ThreadComputeServiceDeps.deliverSystemReminder`.
       */
      mustDeliver?: boolean;
    },
  ) => Promise<void>;
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
  /** Whether exec calls may background commands after the foreground window. */
  backgroundLongRunningExec?: boolean;
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
  /** Sets/clears the "workspace verified clean" bit; backs `confirm_work_saved`. */
  setSandboxDeclaredClean?: (clean: boolean) => Promise<void>;
  /** Read side of the "workspace verified clean" bit; drives idle-release disposition. */
  isSandboxDeclaredClean?: () => Promise<boolean>;
  /** Git-based cleanliness probe; drives idle-release disposition when the bit isn't set. */
  probeWorkspaceCleanliness?: () => Promise<WorkspaceCleanliness>;
  /** @internal for tests only — shrinks sync-first exec timing without waiting on real time. */
  execForegroundTimeoutMs?: number;
  /** @internal for tests only — shrinks sync-first exec polling without waiting on real time. */
  execForegroundPollIntervalMs?: number;
  /** @internal for tests only — advances fake time instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Write surface for the background work ledger (see `WorkLedgerStore`).
   * Threaded through so watched-process registration/liveness stamps land in
   * the ledger the reaper reads; the reaper itself never touches compute.
   */
  workLedger?: WorkLedgerSink;
  /**
   * The ledger's next sweep horizon (`nextSweepAt` over open rows). Supplied by
   * the agent, which owns the ledger. Folded into the compute service's single
   * alarm min-fold so the reaper rides the thread's one alarm instead of
   * arming (and thereby cancelling) it.
   */
  getWorkHorizon?: () => Promise<number | null>;
  /**
   * Fired once, after `ThreadComputeService` acquires a genuinely fresh
   * runtime (not a recovery restore). Wired to `createRepositoryPreparation`
   * so a thread's workbench repos are cloned automatically; a workbench-less
   * thread is a cheap no-op (no repository snapshots to prepare).
   */
  onFreshRuntimeAcquired?: () => Promise<void>;
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
 * The thread's frozen workbench resource profile, or `null` when it has no
 * snapshot (or one predating the column). Callers pass this to
 * `resolveComputeConfigForAgent` / `computeConfigFromInputs` so config resolves
 * against the workbench the thread is actually assigned to rather than the
 * `small` default.
 */
export async function readThreadWorkbenchResourceProfile(
  env: Env,
  threadId: string,
): Promise<ComputeResourceProfile | null> {
  const snapshot = await new ThreadRepositorySnapshotRepository(
    registryDb(env),
  ).listWorkbenchSnapshot(threadId);
  return snapshot?.resourceProfile != null && isComputeResourceProfile(snapshot.resourceProfile)
    ? snapshot.resourceProfile
    : null;
}

/**
 * Whether the thread has a workbench assigned — the configuration-level
 * statement that this thread does repository work (it declares repos, a setup
 * script and a sandbox size). Deliberately independent of
 * {@link readThreadWorkbenchResourceProfile}: that helper returns `null` both
 * for "no workbench" and for "workbench assigned but its stored profile
 * predates the column / fails validation", and only the former means the
 * thread has no workbench.
 */
export async function hasThreadWorkbench(env: Env, threadId: string): Promise<boolean> {
  const snapshot = await new ThreadRepositorySnapshotRepository(
    registryDb(env),
  ).listWorkbenchSnapshot(threadId);
  return snapshot?.workbenchId != null;
}

/**
 * Rewrites the DO-persisted resource profile to the one the thread's CURRENT
 * workbench snapshot declares. Called by `commitWorkbenchSwitchIfPending` right
 * after a successful commit — see `adoptCommittedResourceProfile` there for why
 * the stored value must be rewritten rather than left to age.
 *
 * Reads the snapshot directly instead of going through `resolveComputeService`:
 * that helper deliberately prefers the stored profile over the workbench one,
 * which is precisely the stale value being corrected here.
 *
 * Falls back to the resolved config's profile when the thread has no snapshot
 * profile (an unassigned workbench), so the stored value always tracks whatever
 * the next acquire would otherwise resolve to.
 *
 * It writes the STORE, so like {@link resolveComputeService} it runs inside
 * `AgentSandbox` and nowhere else; the thread DO reaches it through
 * `adoptCommittedResourceProfileOnSandbox`. The parameter is narrowed to what
 * it actually reads so it is legible as "a store write plus two config reads"
 * rather than as another full host wiring.
 */
export async function adoptCommittedWorkbenchResourceProfile(
  deps: Pick<
    ComputeServiceHostDeps,
    "env" | "threadId" | "storage" | "resolveRuntimeConfig" | "now"
  >,
): Promise<void> {
  const { workspaceId, agentId } = await deps.resolveRuntimeConfig();
  const inputs = await loadComputeConfigInputs({ env: deps.env, workspaceId, agentId });
  const workbenchResourceProfile = await readThreadWorkbenchResourceProfile(
    deps.env,
    deps.threadId,
  );

  const config = computeConfigFromInputs(inputs, workbenchResourceProfile);
  if (!config.enabled) return;

  const store = new ThreadComputeStore(deps.storage, config.value.limits);
  store.migrate();
  // No state yet → nothing stale to correct, and `markAcquiring` will seed the
  // freshly-resolved profile itself on the next acquire.
  if (!store.getComputeState()) return;
  store.setResourceProfile(config.value.resourceProfile, (deps.now ?? Date.now)());
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
  // names, credential presence) are independent of the workbench profile, so
  // fetch them exactly once regardless of how many times we resolve below.
  const inputs = await loadComputeConfigInputs({ env: deps.env, workspaceId, agentId });
  // Resolve once with NO profile to learn whether compute is even enabled for
  // this workspace/agent, without paying for the thread's workbench snapshot
  // query. The enabled/disabled decision (aside from `missing_source`, which
  // itself depends on the profile) never consults the profile — see
  // `needsWorkbenchResourceProfile`. This is what keeps a compute-DISABLED
  // workspace from paying an extra D1 round-trip for a value it will never use.
  const preliminary = computeConfigFromInputs(inputs, null);
  if (!needsWorkbenchResourceProfile(preliminary)) return null;

  // `threadWorkbenchId` is the thread's assigned workbench BUNDLE
  // (project/env-vars/setup-script grouping) — distinct from the
  // `environmentId` local below, which names the base OS image for the
  // selected resource profile. Prefer the immutable per-thread snapshot
  // (taken when the bundle was assigned) and fall back to the live
  // `threadIndex.workbenchId` for threads that predate the snapshot. Fetched
  // ONLY once we know compute could actually be enabled (see above), so this
  // query is paid exactly once and never on the disabled path.
  const envSnapshot = await new ThreadRepositorySnapshotRepository(
    registryDb(deps.env),
  ).listWorkbenchSnapshot(deps.threadId);
  const threadWorkbenchId =
    envSnapshot?.workbenchId ??
    (await new ThreadRepository(registryDb(deps.env)).getById(deps.threadId))?.workbenchId ??
    null;
  const workbenchResourceProfile =
    envSnapshot?.resourceProfile != null && isComputeResourceProfile(envSnapshot.resourceProfile)
      ? envSnapshot.resourceProfile
      : null;

  const config = computeConfigFromInputs(inputs, workbenchResourceProfile);
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
  // Prefer a profile persisted on state (from a running sandbox created under
  // an earlier workbench) so the backend is built for the environment source
  // that sandbox is actually acquired under, not just the settings default.
  const effectiveProfile = computeState?.resourceProfile ?? config.value.resourceProfile;

  let environmentEditableEnv: Record<string, string> = {};
  let environmentSecretEnvNames: string[] = [];
  // Workbench-level allowlist additions, applied additively on top of the
  // workspace list. A Daytona workbench can also activate restrictions itself;
  // that path must restore enabled MCP hosts that the unrestricted workspace
  // resolution intentionally left out.
  let workbenchNetworkHosts: string[] = [];
  if (threadWorkbenchId) {
    const workbenchRow = await new WorkbenchRepository(registryDb(deps.env)).getById(
      threadWorkbenchId,
    );
    if (workbenchRow) {
      environmentEditableEnv = parseEnvVarsJson(workbenchRow.sandboxEnvVarsJson);
      workbenchNetworkHosts = parseDomainList(workbenchRow.sandboxNetworkDomainAllowlist);
    }
    const { store: secretsStore, writer: secretsWriter } = createWorkspaceSecretsServices(deps.env);
    const envSecretsStore = new ComputeEnvSecretsStore({
      store: secretsStore,
      writer: secretsWriter,
    });
    const envSecretNames = await envSecretsStore.listEnvironmentNames(
      workspaceId,
      threadWorkbenchId,
    );
    environmentSecretEnvNames = envSecretNames.map((n) => n.name);
  }

  const baseAllowlist =
    config.value.provider === "daytona" &&
    config.value.allowedHosts === null &&
    workbenchNetworkHosts.length > 0
      ? DEFAULT_COMPUTE_ALLOWED_HOSTS
      : config.value.allowedHosts;
  const widenedAllowlist = unionAllowlistWithSkillDomains(baseAllowlist, [
    ...inputs.mcpHosts,
    ...skillDomains,
    ...workbenchNetworkHosts,
  ]);

  const effectiveConfig: EffectiveComputeConfig = {
    ...config.value,
    allowedHosts: widenedAllowlist,
    resourceProfile: effectiveProfile,
    environmentEditableEnv,
    environmentSecretEnvNames,
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
    // The thread's workbench id, threaded through to layer in its editable +
    // secret env vars. Unrelated to the base-image `environmentId` local above.
    environmentId: threadWorkbenchId,
    config: effectiveConfig,
  });
  // Populate GH_TOKEN from a GitHub App installation when configured and unset.
  let effectiveEnv = computeEnv;
  const githubConfig = getGithubAppConfig(deps.env);
  if (githubConfig) {
    const snapshots = await new ThreadRepositorySnapshotRepository(
      registryDb(deps.env),
    ).listForThread(deps.threadId);
    effectiveEnv = await applyGithubToken({
      db: registryDb(deps.env),
      workspaceId,
      config: githubConfig,
      existingEnv: computeEnv,
      repoUrls: snapshots.map((s) => s.url),
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
  const quota = buildComputeQuotaGate({
    env: deps.env,
    effectiveConfig,
    daytonaMode: inputs.daytonaConfiguration?.mode ?? null,
    spritesMode: inputs.spritesConfiguration?.mode ?? null,
    workspaceId,
    threadId: deps.threadId,
    now,
  });
  const backgroundLongRunningExec = deps.backgroundLongRunningExec ?? !deps.attachedRuntime;
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
    clearAlarm: () => deps.cancelEviction(),
    now,
    deliverSystemReminder: deps.deliverSystemReminder,
    supportsProcessMonitor: deps.supportsProcessMonitor,
    backgroundLongRunningExec,
    ...(deps.attachedRuntime ? { attachedRuntime: deps.attachedRuntime } : {}),
    ...(quota ? { quota } : {}),
    ...(deps.hasBlockingWork ? { hasBlockingWork: deps.hasBlockingWork } : {}),
    ...(deps.markSandboxDirty ? { markSandboxDirty: deps.markSandboxDirty } : {}),
    ...(deps.isSandboxDeclaredClean ? { isSandboxDeclaredClean: deps.isSandboxDeclaredClean } : {}),
    ...(deps.probeWorkspaceCleanliness
      ? { probeWorkspaceCleanliness: deps.probeWorkspaceCleanliness }
      : {}),
    ...(deps.execForegroundTimeoutMs !== undefined
      ? { execForegroundTimeoutMs: deps.execForegroundTimeoutMs }
      : {}),
    ...(deps.execForegroundPollIntervalMs !== undefined
      ? { execForegroundPollIntervalMs: deps.execForegroundPollIntervalMs }
      : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.workLedger ? { workLedger: deps.workLedger } : {}),
    ...(deps.getWorkHorizon ? { getWorkHorizon: deps.getWorkHorizon } : {}),
    ...(deps.onFreshRuntimeAcquired ? { onFreshRuntimeAcquired: deps.onFreshRuntimeAcquired } : {}),
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
 * Builds the per-workspace sandbox cap, for the providers that spend the
 * operator's capacity — see {@link isQuotaGatedProvider}. Split out from
 * {@link resolveComputeService} so that gate is testable on its own.
 */
export function buildComputeQuotaGate(input: {
  env: Env;
  effectiveConfig: EffectiveComputeConfig;
  /** The workspace's resolved Daytona mode; null when it is not a Daytona workspace. */
  daytonaMode: DaytonaConfigurationMode | null;
  /** The workspace's resolved Sprites mode; null when it is not a Sprites workspace. */
  spritesMode: SpritesConfigurationMode | null;
  workspaceId: string;
  threadId: string;
  now: () => number;
}): ComputeQuotaGate | undefined {
  if (!isQuotaGatedProvider(input.effectiveConfig.provider, input.daytonaMode, input.spritesMode))
    return undefined;
  return createComputeQuotaGate({
    ledger: new ContainerLedger(registryBinding(input.env)),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    provider: input.effectiveConfig.provider,
    profile: input.effectiveConfig.resourceProfile,
    idleTimeoutMs: input.effectiveConfig.idleTimeoutMs,
    limit: parseMaxActiveContainers(input.env.MAX_ACTIVE_CONTAINERS_PER_WORKSPACE),
    now: input.now,
    reclaim: (threadId) => reclaimContainer(input.env, threadId),
  });
}

/**
 * Ask another thread's DO to give up its idle container.
 *
 * MUST go through getAgentByName, not `namespace.get(idFromName(...))` — the raw
 * stub bypasses the entry points where onStart() runs (see src/automata/fire-due.ts).
 *
 * Time-boxed: a DO is single-threaded, so a target mid-turn would otherwise make
 * the caller wait behind its queue. A timeout is just a refusal.
 *
 * Imports `agents` dynamically: it touches `cloudflare:workers` at module load,
 * which breaks node-environment unit tests (e.g. compute-tools-env.test.ts)
 * that import this file only for the tool-def builder and never reach this
 * function. A static top-level import would drag that failure into every
 * consumer of this module regardless of whether reclaim ever runs.
 */
async function reclaimContainer(env: Env, threadId: string): Promise<boolean> {
  const { getAgentByName } = await import("agents");
  const stub = (await getAgentByName(env.THINK_THREAD_AGENT, threadId)) as unknown as {
    releaseIfReclaimable: () => Promise<boolean>;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), RECLAIM_RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([stub.releaseIfReclaimable(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** DO storage key: id of the single outstanding compute-eviction schedule. */
export const COMPUTE_EVICTION_SCHEDULE_KEY = "sandbox:eviction-schedule-id";

/**
 * The Agents SDK owns the physical Durable Object `alarm()` (it drives the
 * framework's scheduler), so compute idle eviction is scheduled through the
 * documented `schedule()`/`cancelSchedule()` hooks rather than by overriding
 * `alarm()`. This narrow interface is what {@link scheduleComputeEviction}
 * needs from the host agent.
 */
export interface ComputeAlarmHost {
  storage: DurableObjectStorage;
  schedule: (when: Date, callback: string) => Promise<{ id: string }>;
  cancelSchedule: (id: string) => Promise<boolean>;
}

/**
 * (Re)arm the thread's single idle-eviction alarm at `timestampMs`. Because
 * {@link ThreadComputeService} calls this after every compute operation to push
 * the eviction time forward, we cancel the prior schedule first so exactly one
 * eviction callback is ever outstanding (no accumulation across refreshes).
 */
export async function scheduleComputeEviction(
  host: ComputeAlarmHost,
  timestampMs: number,
  callbackName: string,
): Promise<void> {
  // Race note (benign, self-healing): cancel-prior then schedule-new is not
  // atomic, so two rapid refreshes interleaving at these awaits could briefly
  // leave an orphan schedule (a stale callback whose id is no longer stored).
  // That is harmless — the eviction tick is idempotent and reschedules itself
  // when the environment is still within its idle budget, and releaseIfIdle
  // no-ops on an already-released environment. The DO's single-threaded event
  // model also serializes these calls in practice (each refresh awaits before
  // the next compute op), so at most one schedule is normally outstanding. A
  // stored id is always the most recent, so the next refresh cancels the right
  // one.
  const priorId = await host.storage.get<string>(COMPUTE_EVICTION_SCHEDULE_KEY);
  if (priorId) {
    try {
      await host.cancelSchedule(priorId);
    } catch {
      /* prior schedule already fired or was cleared */
    }
  }
  const created = await host.schedule(new Date(timestampMs), callbackName);
  await host.storage.put(COMPUTE_EVICTION_SCHEDULE_KEY, created.id);
}

/**
 * Cancel the thread's outstanding idle-eviction alarm and forget its id. Used
 * by `exec_shutdown`, which tears the environment down immediately so there is
 * nothing left to evict. Safe to call when no schedule is outstanding (no-op).
 */
export async function cancelComputeEviction(host: {
  storage: DurableObjectStorage;
  cancelSchedule: (id: string) => Promise<boolean>;
}): Promise<void> {
  const priorId = await host.storage.get<string>(COMPUTE_EVICTION_SCHEDULE_KEY);
  if (!priorId) return;
  try {
    await host.cancelSchedule(priorId);
  } catch {
    /* schedule already fired or was cleared */
  }
  await host.storage.delete(COMPUTE_EVICTION_SCHEDULE_KEY);
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
 * The two preconditions `confirm_workbench_switch` cannot safely run without,
 * bundled so they arrive together or not at all.
 *
 * `hasBlockingWork` used to be an independent optional that defaulted to
 * `async () => false` — failing OPEN on a safety precondition. Because the
 * commit happens BEFORE `execShutdown`, a false `false` moves the snapshot to
 * the new workbench and only then has `execShutdown` throw
 * `compute_children_active`; that teardown failure is swallowed by design, so
 * the thread is left with the new snapshot, the old sandbox, and live subagents
 * still running on it — exactly the inconsistency the mechanism exists to
 * prevent.
 *
 * Making the bundle gate tool REGISTRATION (below) is stronger than making the
 * field required: a required field can still be satisfied with a stub
 * `async () => false`, whereas a caller that has not wired the preconditions
 * simply never gets the dangerous tool.
 */
export interface WorkbenchSwitchToolDeps {
  hasBlockingWork: () => Promise<boolean>;
  adoptCommittedResourceProfile: () => Promise<void>;
}

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
  workbenchSwitch?: WorkbenchSwitchToolDeps | undefined;
  workSaved?: WorkSavedToolDeps | undefined;
  now?: (() => number) | undefined;
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
    workbenchSwitch,
    workSaved,
    now,
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
    // Registered only with its safety preconditions wired AND when this is not
    // an attached subagent runtime — see `WorkbenchSwitchToolDeps`. Levelled up
    // to match `confirm_work_saved`'s gate below: `createComputeTools` already
    // omits `workbenchSwitch` from the options when `attachedRuntime` is set,
    // but checking it again here (not only at the bundle-construction site)
    // means the invariant holds regardless of how this function is called —
    // a subagent reaching either tool is a data-loss bug, so the defensive
    // check is cheap insurance against a future caller skipping that gate.
    ...(workbenchSwitch && !attachedRuntime
      ? {
          confirm_workbench_switch: tool({
            description:
              "Confirm that all work in the current sandbox has been saved, so a user-requested workbench switch can proceed. The sandbox is destroyed immediately after this call. Only call this after committing and pushing anything worth keeping, or if there is nothing to save.",
            inputSchema: z.object({}),
            execute: async () => {
              try {
                const { env, threadId } = await getFileContext();
                return await commitWorkbenchSwitchIfPending({
                  threadId,
                  now: now ?? (() => Date.now()),
                  commitWorkbenchSwitch: (id, at) =>
                    new ThreadRepository(registryDb(env)).commitWorkbenchSwitch(id, at),
                  execShutdown: async () => (await getService()).execShutdown({ confirm: true }),
                  hasBlockingWork: workbenchSwitch.hasBlockingWork,
                  adoptCommittedResourceProfile: workbenchSwitch.adoptCommittedResourceProfile,
                  onTeardownFailure: (error) =>
                    log.warn("compute_tools.workbench_switch_teardown_failed", {
                      threadId,
                      error: String(error),
                    }),
                });
              } catch (error) {
                return toErrorResult(error);
              }
            },
          }),
        }
      : {}),
    // Registered only when its verification dependencies are wired AND this is
    // not an attached subagent runtime — see `WorkSavedToolDeps`. An attached
    // subagent shares its parent's runtime, so letting it declare the parent's
    // sandbox discardable would destroy the parent's work; checked here (not
    // only in `createComputeTools`) so the invariant holds regardless of caller.
    ...(workSaved && !attachedRuntime
      ? {
          confirm_work_saved: tool({
            description:
              "Declare that all work in the sandbox is committed and pushed. This permits the idle sandbox to be discarded rather than preserved. The workspace is checked before the declaration is accepted: if any repository has uncommitted changes or unpushed commits, the call is refused and the offending paths are returned. Call this when you have finished working and everything is saved.",
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
  /** Owner-side child-subagent gate; gates `confirm_workbench_switch`'s registration. */
  hasBlockingWork?: () => Promise<boolean>;
  /** Sets/clears the "workspace verified clean" bit; backs `confirm_work_saved`. */
  setSandboxDeclaredClean?: (clean: boolean) => Promise<void>;
  /**
   * Rewrites the sandbox's persisted resource profile after a workbench switch
   * commits. A callback because the write lands in the sandbox DO's store — see
   * {@link adoptCommittedWorkbenchResourceProfile}.
   */
  adoptCommittedResourceProfile: () => Promise<void>;
  /** @internal for tests only — the `work_saved` probe's clock. */
  now?: () => number;
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
  // Same test-only substitution `resolveComputeService` applies — repeated here
  // because this factory reads `deps.now` itself (the `work_saved` probe's
  // clock) rather than only through the resolved service.
  const deps = applyComputeHostTestOverrides(toolDeps);
  const { supportsProcessMonitor, backgroundLongRunningExec, attachedRuntime } = deps;
  const resolved = session;
  if (!resolved) return {};
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
      // Gated on `attachedRuntime` being absent, the same way the tool this
      // replaced (`select_sandbox_package`) was hidden from attached
      // subagents: a subagent's `confirm_workbench_switch` call would resolve
      // against its OWN thread row, which never has a pending switch, so it
      // could only fail. `hasBlockingWork` alone doesn't distinguish this —
      // the thread's tool deps set it unconditionally — and checking "is a
      // switch actually pending for THIS thread" would cost a D1 round-trip on
      // every turn's tool build, which this codebase's latency budget (D1-from-DO
      // ~220ms, sequential wave count dominates) rules out. Attached-runtime is
      // knowable synchronously, so it's the gate.
      workbenchSwitch:
        deps.hasBlockingWork && !attachedRuntime
          ? {
              hasBlockingWork: deps.hasBlockingWork,
              adoptCommittedResourceProfile: deps.adoptCommittedResourceProfile,
            }
          : undefined,
      // Gated on `!attachedRuntime` for the same reason as `workbenchSwitch`:
      // an attached subagent shares the parent's runtime, so letting it
      // declare the parent's sandbox discardable would destroy the parent's
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
      now: deps.now,
    },
  );
  // Model-native file tools share the same lease/runtime resolution as exec and
  // are exposed only when compute is enabled (this factory returns {} above when
  // it is not).
  const fileTools = buildComputeFileToolDefs(async () => resolved.service.files);
  return { ...execTools, ...fileTools };
}
