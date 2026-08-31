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

/**
 * Thread ids whose registered overrides were actually LAYERED IN by
 * {@link applyComputeHostTestOverrides} since they were registered.
 *
 * This exists because nothing else can see the seam break. Every suite that
 * uses this registry asserts on backend/tool BEHAVIOUR, never on registry
 * state, so dropping the `applyComputeHostTestOverrides` call from
 * `resolveComputeService` (or from `createComputeTools`) leaves all of those
 * tests compiling, registering an override nobody reads, and quietly running
 * against the real host deps instead of the fake they think they installed —
 * i.e. vacuous, and green. The registered-but-never-read case is therefore an
 * ERROR, raised by {@link clearComputeHostTestOverrides}, which every suite
 * already calls.
 */
const CONSUMED = new Set<string>();

/** Test-only: install overrides for `threadId` until cleared. */
export function setComputeHostTestOverrides(
  threadId: string,
  overrides: ComputeHostTestOverrides,
): void {
  OVERRIDES.set(threadId, overrides);
  // A re-registration starts a fresh obligation: the NEW object has not been
  // read yet, whatever became of the one it replaces.
  CONSUMED.delete(threadId);
}

/**
 * Test-only: drop one thread's overrides, or every thread's when omitted.
 *
 * THROWS when the thread's overrides were registered and never consumed — see
 * {@link CONSUMED}. The blanket form cannot make that check (it is a catch-all
 * teardown for threads a route call may or may not have reached), so prefer
 * the scoped one.
 */
export function clearComputeHostTestOverrides(threadId?: string): void {
  if (threadId === undefined) {
    OVERRIDES.clear();
    CONSUMED.clear();
    return;
  }
  const registered = OVERRIDES.delete(threadId);
  const consumed = CONSUMED.delete(threadId);
  if (registered && !consumed) {
    throw new Error(
      `compute host test overrides for "${threadId}" were registered but never consumed: ` +
        "nothing called applyComputeHostTestOverrides for that thread, so the test ran " +
        "against the real host deps. Either the code under test stopped consulting the " +
        "registry, or the test registered a thread id it never drove.",
    );
  }
}

/**
 * Layers any registered overrides over `deps`. Returns the SAME object when
 * nothing is registered, so the production path allocates nothing.
 */
export function applyComputeHostTestOverrides<T extends { threadId: string }>(deps: T): T {
  const overrides = OVERRIDES.get(deps.threadId);
  if (!overrides) return deps;
  CONSUMED.add(deps.threadId);
  return { ...deps, ...overrides };
}
