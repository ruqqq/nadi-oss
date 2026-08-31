import type { Env } from "../env";
import type { BackendReference } from "./backend";
import type { EffectiveComputeConfig } from "./types";
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
export type SandboxSessionClient = {
  [K in keyof SandboxSession]: SandboxSession[K] extends (
    ...args: infer A
  ) => Promise<SandboxCallResult<infer R>>
    ? (...args: A) => Promise<R>
    : never;
} & {
  /**
   * Regrouped locally, NOT a nested stub. `ThreadComputeService.files` returns
   * a live `ComputeFileService` closing over non-cloneable deps, so it cannot
   * cross the boundary; the three methods travel flat on the session (one round
   * trip each) and are re-grouped here so `buildComputeFileToolDefs`, which
   * takes a `() => Promise<ComputeFileService>`, keeps the shape it has.
   */
  files: Pick<SandboxSessionClient, "readFile" | "writeFile" | "applyPatch">;
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
 * Opens ONE per-turn compute session on the thread's `AgentSandbox`.
 *
 * Deliberately shaped like `resolveComputeService`: `{ service, workspaceId,
 * config }`, or `null` when compute is DISABLED for the thread — which callers
 * must keep treating as "hide every compute tool, schedule no eviction alarm".
 * A resolve that FAILED throws instead, so a broken resolve is never mistaken
 * for a disabled one.
 *
 * `idFromName` (not `getAgentByName`) is deliberate: `AgentSandbox` is a plain
 * Durable Object with no `onStart` to bypass, unlike the thread agent.
 *
 * LIFETIME: the returned `service` is an RPC stub. Open it inside the
 * invocation that uses it and let it go at the end; do NOT stash it in a
 * Durable Object instance field to be read by a later invocation. See
 * `test/integration/agent-sandbox-session.integration.test.ts` for what a
 * dropped stub does at the call site.
 */
export async function openSandboxSession(
  env: Env,
  threadId: string,
  options: { supportsProcessMonitor: boolean; attachedRuntime?: BackendReference },
): Promise<{
  service: SandboxSessionClient;
  workspaceId: string;
  config: EffectiveComputeConfig;
} | null> {
  const sandbox = env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(threadId));
  const opened = await sandbox.session({
    threadId,
    supportsProcessMonitor: options.supportsProcessMonitor,
    ...(options.attachedRuntime ? { attachedRuntime: options.attachedRuntime } : {}),
  });
  if (!opened.ok) throw decodeSandboxError(opened.error);
  if (!opened.value) return null;
  return {
    service: unwrapping(opened.value.session),
    workspaceId: opened.value.workspaceId,
    config: opened.value.config,
  };
}
