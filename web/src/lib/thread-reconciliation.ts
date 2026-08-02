import { reconcileThreads } from "../threads-api";

const RECONCILE_BATCH_SIZE = 100;

export async function findInactiveThreadIds(
  threadIds: string[],
  reconcile: (threadIds: string[]) => Promise<string[]> = reconcileThreads,
): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set();
  const batches: string[][] = [];
  for (let index = 0; index < threadIds.length; index += RECONCILE_BATCH_SIZE) {
    batches.push(threadIds.slice(index, index + RECONCILE_BATCH_SIZE));
  }
  const activeBatches = await Promise.all(batches.map((batch) => reconcile(batch)));
  const active = new Set(activeBatches.flat());
  return new Set(threadIds.filter((id) => !active.has(id)));
}
