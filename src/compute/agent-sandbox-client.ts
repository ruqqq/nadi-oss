import type { Env } from "../env";
import type { BackendReference } from "./backend";
import type { ComputeResolvePurpose, EffectiveComputeConfig } from "./types";
import {
  decodeSandboxError,
  unwrapSandboxCall,
  type SandboxCallResult,
  type SandboxSession,
} from "./agent-sandbox-session";

/**
 * The near side of {@link SandboxSession}: the same methods, with the
 * `SandboxCallResult` envelope removed and the far side's error re-thrown.
 *
 * Unwrapping here rather than at ~35 call sites is what makes the cutover
 * mechanical — `resolveComputeService(...)` returns `{ service, workspaceId,
 * config } | null` and so does {@link openSandboxSession}, with `service`
 * answering to the same method names — and it is the ONLY place that has to
 * know an RPC boundary exists at all.
 */
type SandboxSessionMethods = {
  [K in keyof SandboxSession]: SandboxSession[K] extends (
    ...args: infer A
  ) => Promise<SandboxCallResult<infer R>>
    ? (...args: A) => Promise<R>
    : never;
};

/**
 * The regrouped file facet. Named off `SandboxSessionMethods` rather than off
 * `SandboxSessionClient` so the alias is NOT circular: a self-referential
 * `Pick<SandboxSessionClient, ...>` makes TypeScript bail out of the recursion
 * and call the type assignable to things it is not — including
 * `ComputeFileService`, whose private field is supposed to reject it. A type
 * that is accidentally assignable to everything checks nothing.
 */
export type SandboxFileClient = Pick<
  SandboxSessionMethods,
  "readFile" | "writeFile" | "applyPatch"
>;

export type SandboxSessionClient = SandboxSessionMethods & {
  /**
   * Regrouped locally, NOT a nested stub. `ThreadComputeService.files` returns
   * a live `ComputeFileService` closing over non-cloneable deps, so it cannot
   * cross the boundary; the three methods travel flat on the session (one round
   * trip each) and are re-grouped here so `buildComputeFileToolDefs`, which
   * takes a `() => Promise<ComputeFileService>`, keeps the shape it has.
   */
  files: SandboxFileClient;
};

/**
 * What an opened session hands back — deliberately the same shape
 * `resolveComputeService` returned to the thread DO, so the ~35 call sites
 * changed their ACQUISITION line and nothing else. `null` means compute is
 * disabled for the thread.
 */
export type SandboxSessionResolution = {
  service: SandboxSessionClient;
  workspaceId: string;
  config: EffectiveComputeConfig;
};

const FILE_METHODS = ["readFile", "writeFile", "applyPatch"] as const;

/**
 * Wraps a session stub so each call unwraps its envelope.
 *
 * A `Proxy` rather than ~45 hand-written forwarders: every forwarder would be
 * the same line, and a hand-written list is a list that silently falls behind
 * the session it mirrors. The mapped type above is what keeps this typed.
 */
function unwrapping(session: object): SandboxSessionClient {
  const cache = new Map<string, unknown>();
  const client = new Proxy({} as SandboxSessionClient, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      // A Proxy that answers to `then` with a function is mistaken for a
      // thenable and awaited into oblivion.
      if (property === "then") return undefined;
      if (property === "files") return files;
      const cached = cache.get(property);
      if (cached) return cached;
      const target = session as unknown as Record<
        string,
        (...a: unknown[]) => Promise<SandboxCallResult<unknown>>
      >;
      const method = async (...args: unknown[]) =>
        unwrapSandboxCall(await target[property]!(...args));
      cache.set(property, method);
      return method;
    },
  });
  const files = Object.fromEntries(
    FILE_METHODS.map((name) => [name, (input: never) => client[name](input)]),
  ) as SandboxSessionClient["files"];
  return client;
}

/**
 * The AGENT's sandbox DO — one box per agent, shared by every thread of it.
 *
 * Keyed by `agentId`, not `threadId`: the machine belongs to the agent and its
 * filesystem outlives any one conversation. The thread is still named on every
 * `session()` call, because the SESSION is per-thread even though the box is
 * not.
 *
 * The agent id comes from the caller's `runtimeConfig`, which is the only
 * authority on it: a `SubAgent`'s facet name is a RUN id with no `thread_index`
 * row, and its agent is its PARENT's — so a D1 lookup on the thread id would
 * throw for every subagent turn and, worse, a guess would address (and bill)
 * the wrong agent's machine.
 *
 * `idFromName` (not `getAgentByName`) is deliberate: `AgentSandbox` is a plain
 * Durable Object with no `onStart` to bypass, unlike the thread agent — whose
 * transcript hydrates in `onStart` and which must therefore be reached with
 * `getAgentByName`. Both are right; do not harmonize them.
 */
function agentSandboxFor(env: Env, agentId: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentId));
}

/**
 * Opens ONE per-turn compute session on the AGENT's `AgentSandbox`.
 *
 * Deliberately shaped like `resolveComputeService`: `{ service, workspaceId,
 * config }`, or `null` when compute is DISABLED for the thread — which callers
 * must keep treating as "hide every compute tool, schedule no eviction alarm".
 * A resolve that FAILED throws instead, so a broken resolve is never mistaken
 * for a disabled one.
 *
 * Addressed via {@link agentSandboxFor} — see there for why `idFromName`.
 *
 * LIFETIME: the returned `service` is an RPC stub. Open it inside the
 * invocation that uses it and let it go at the end; do NOT stash it in a
 * Durable Object instance field to be read by a later invocation. The one
 * caller that holds it at all (`ThinkThreadAgent._turnSandbox`) holds it
 * for the span of ONE turn, which is one invocation, and nulls it at both ends.
 * See
 * `test/integration/agent-sandbox-session.integration.test.ts` for what a
 * dropped stub does at the call site.
 */
export async function openSandboxSession(
  env: Env,
  threadId: string,
  options: {
    /**
     * The thread whose working directory the session works in — the caller's
     * own thread, or a subagent's PARENT thread. Required; see
     * `AgentSandbox.session`.
     */
    workspaceThreadId: string;
    supportsProcessMonitor: boolean;
    /**
     * The CALLER's workspace/agent. Required, because `threadId` does not
     * determine it: a `SubAgent`'s id is a run id with no thread row, and its
     * config is its parent's. See `AgentSandbox.session`.
     *
     * `agentId` is ALSO the DO key — see {@link agentSandboxFor}. It was
     * already required for the resolve, which is why re-keying needed no new
     * input at any of the call sites.
     */
    runtimeConfig: { workspaceId: string; agentId: string };
    /**
     * Why the session is being opened. Omit for ordinary work. `"teardown"`
     * is the agent-deletion path, which must reach the machine of an agent
     * that is disabled or already archived — see {@link ComputeResolvePurpose}.
     */
    purpose?: ComputeResolvePurpose;
    attachedRuntime?: BackendReference;
  },
): Promise<SandboxSessionResolution | null> {
  const sandbox = agentSandboxFor(env, options.runtimeConfig.agentId);
  const opened = await sandbox.session({
    threadId,
    workspaceThreadId: options.workspaceThreadId,
    supportsProcessMonitor: options.supportsProcessMonitor,
    runtimeConfig: options.runtimeConfig,
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.attachedRuntime ? { attachedRuntime: options.attachedRuntime } : {}),
  });
  if (!opened.ok) throw decodeSandboxError(opened.error);
  if (!opened.value) return null;
  return nearSideSandboxSession(
    opened.value.session,
    opened.value.workspaceId,
    opened.value.config,
  );
}

/**
 * Wrap a session stub that arrived by some route other than {@link
 * openSandboxSession} — today, the one the sandbox DO's alarm PASSES INTO the
 * thread DO's ledger sweep so the sweep reuses the tick's resolution instead of
 * paying a second `resolveComputeService`.
 *
 * The same lifetime rule applies, and is what makes that safe: the stub is
 * valid for the invocation that opened it, and the sweep runs inside the
 * alarm's own invocation, awaited by it.
 */
export function nearSideSandboxSession(
  // `object`, like {@link unwrapping}: what actually arrives is a `Stub<...>`,
  // whose type is not the class it stands for. The `SandboxSessionClient` result
  // is where the typing is enforced.
  session: object,
  workspaceId: string,
  config: EffectiveComputeConfig,
): SandboxSessionResolution {
  return { service: unwrapping(session), workspaceId, config };
}
