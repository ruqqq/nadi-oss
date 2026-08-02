/**
 * A single-slot async cache: the factory runs at most once, its result is shared
 * by every `get()` until `invalidate()` is called. A rejection is never cached —
 * the slot clears so the next `get()` retries.
 *
 * Used to collapse the repeated, unmemoized `resolveRuntimeConfigForThink` D1
 * joins that dominated cold thread-open latency (5-7 identical queries per wake)
 * into one, while `invalidate()` at each turn boundary preserves the existing
 * "config changes apply on the next turn" contract.
 */
export interface InvalidatablePromiseCache<T> {
  get(): Promise<T>;
  invalidate(): void;
}

export function invalidatablePromiseCache<T>(
  factory: () => Promise<T>,
): InvalidatablePromiseCache<T> {
  let cached: Promise<T> | null = null;
  return {
    get(): Promise<T> {
      if (!cached) {
        cached = factory().catch((error) => {
          // Don't wedge the slot on a transient failure — let the next get()
          // re-run the factory.
          cached = null;
          throw error;
        });
      }
      return cached;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
