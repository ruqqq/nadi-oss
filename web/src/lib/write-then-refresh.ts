import { toast } from "sonner";

export type WriteResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Run a write, then re-read — and never let the re-read reverse the write.
 *
 * The defect this exists to make unwriteable:
 *
 * ```ts
 * try { await write(); await refresh(); } catch { toast("Couldn’t save"); }
 * ```
 *
 * A write the server ACCEPTED followed by a failed refresh lands in that one
 * `catch` and is reported as a failed save. The draft stays open, the caller
 * rolls its optimistic state back, and the obvious retry then 409s against the
 * row the server already holds. The UI states the opposite of the truth.
 *
 * Splitting the two `await`s by hand works and did not stick: the same defect
 * was written eight times across two phases of this branch, twice within a
 * commit of its own fix and once eight lines below a doc comment stating the
 * rule. So the split is structural here instead. A refresh failure cannot
 * reach the caller — it can only toast `staleMessage` and let the change
 * stand — and the caller cannot read `value` without first handling `ok:
 * false`, which is the write's own failure and the only one it owns.
 *
 * Write failures are returned rather than toasted: callers differ on how they
 * report one (a form's inline error, a toast, a rethrow into a dialog that
 * keeps the draft), and a toast fired from in here would double up with theirs.
 */
export async function writeThenRefresh<T>(
  write: () => Promise<T>,
  refresh: () => Promise<unknown>,
  staleMessage: string,
): Promise<WriteResult<T>> {
  let value: T;
  try {
    value = await write();
  } catch (error) {
    return { ok: false, error };
  }
  try {
    await refresh();
  } catch {
    toast.error(staleMessage);
  }
  return { ok: true, value };
}
