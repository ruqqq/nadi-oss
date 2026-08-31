import type { ComputeToolHostDeps } from "../agent/compute-tools";

/**
 * The host-dep knobs a test may substitute: the backend factory plus the clock
 * and foreground-exec timing the {@link ThreadComputeService} reads. Exactly the
 * set `ThinkThreadAgent._testSandboxServiceOverrides` used to carry.
 */
export type ComputeHostTestOverrides = Pick<
  ComputeToolHostDeps,
  "buildBackend" | "now" | "execForegroundTimeoutMs" | "execForegroundPollIntervalMs" | "sleep"
>;

/**
 * TEST-ONLY host-dep overrides, keyed by thread id, consulted by
 * `resolveComputeService` / `createComputeTools`.
 *
 * Why a module-level registry rather than a property on the DO that resolves
 * the service: the compute service is moving OFF the thread Durable Object and
 * into `AgentSandbox`, so an override set on a `ThinkThreadAgent` instance
 * would have to cross a DO RPC boundary to reach the code that reads it — and
 * a `buildBackend` closure (or a `sleep` that advances the test's fake clock)
 * is not serializable, so it cannot cross one. Integration tests run in the
 * SAME worker isolate as every Durable Object they drive, so a module-level map
 * reaches both DOs unchanged, whichever one owns the service.
 *
 * It is empty in production: nothing but tests ever calls
 * {@link setComputeHostTestOverrides}, so `applyComputeHostTestOverrides`
 * returns the caller's own deps object untouched.
 */
const OVERRIDES = new Map<string, ComputeHostTestOverrides>();

/** Test-only: install overrides for `threadId` until cleared. */
export function setComputeHostTestOverrides(
  threadId: string,
  overrides: ComputeHostTestOverrides,
): void {
  OVERRIDES.set(threadId, overrides);
}

/** Test-only: drop one thread's overrides, or every thread's when omitted. */
export function clearComputeHostTestOverrides(threadId?: string): void {
  if (threadId === undefined) {
    OVERRIDES.clear();
    return;
  }
  OVERRIDES.delete(threadId);
}

/**
 * Layers any registered overrides over `deps`. Returns the SAME object when
 * nothing is registered, so the production path allocates nothing.
 */
export function applyComputeHostTestOverrides<T extends { threadId: string }>(deps: T): T {
  const overrides = OVERRIDES.get(deps.threadId);
  if (!overrides) return deps;
  return { ...deps, ...overrides };
}
