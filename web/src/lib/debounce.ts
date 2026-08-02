/**
 * Debounce a function: calls within `delayMs` of each other collapse into one
 * trailing call with the latest args. `.flush()` runs any pending call now;
 * `.cancel()` drops it. Used to coalesce composer draft writes while typing.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  flush(): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: A | undefined;

  const fire = () => {
    timer = undefined;
    if (pendingArgs) {
      const args = pendingArgs;
      pendingArgs = undefined;
      fn(...args);
    }
  };

  const debounced = ((...args: A) => {
    pendingArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, delayMs);
  }) as Debounced<A>;

  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      fire();
    }
  };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pendingArgs = undefined;
  };

  return debounced;
}
