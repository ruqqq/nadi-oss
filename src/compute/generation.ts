import type { BackendReference, ComputeBackend, DirEntry } from "./backend";

/**
 * The directory holding the nonce. `/tmp` deliberately: the nonce must die with
 * the container. A Cloudflare OOM returns a FRESH, EMPTY container under the
 * SAME sandbox id, so the id proves nothing — the only honest signal that the
 * filesystem survived is a file we wrote still being there.
 *
 * This is also the directory `readGeneration` lists, and that listing is the
 * whole probe: see there.
 */
export const GENERATION_DIR = "/tmp";

/** The nonce's filename. Dot-prefixed — every listing of it needs includeHidden. */
export const GENERATION_NAME = ".nadi-generation";

/**
 * Derived, not spelled out: `readGeneration` matches this name against a listing
 * of this directory, so a path that could drift from either half would break the
 * probe silently.
 */
export const GENERATION_PATH = `${GENERATION_DIR}/${GENERATION_NAME}`;

/** A nonce is a UUID; this is generous headroom, not a tuning knob. */
const GENERATION_MAX_BYTES = 256;

/**
 * What one probe of the live container learned. The three arms are NOT
 * interchangeable and collapsing them was the production bug (2026-07-16):
 *
 *  - `found`   — the nonce is there; compare it to the row's.
 *  - `absent`  — the container ANSWERED and the nonce is not there. That is a
 *                reset: the filesystem was wiped under a live container. This
 *                is the case the live run proved is the REAL one — Cloudflare
 *                silently hands back a working container on the same sandbox
 *                id after a destroy/OOM, so nothing ever throws
 *                `SandboxNotFound`, the DO never re-provisions, and the nonce
 *                never diverges. Absent-but-answered is the only signal left.
 *  - `unreadable` — genuinely unknown. Callers MUST NOT treat it as a reset: a
 *                false `sandbox_reset` tells a model its work is lost when it
 *                is not, which is worse than the under-informative
 *                `no_liveness` message it degrades to.
 */
export type GenerationProbe =
  | { kind: "found"; nonce: string }
  | { kind: "absent" }
  | { kind: "unreadable" };

/**
 * Deliberately NOT dirty-tracked: this is our own liveness write, on every
 * acquisition. Marking it would clear the declared-clean bit on every sandbox
 * wake, so a declaration could never survive to release.
 */
export async function writeGeneration(
  backend: ComputeBackend,
  runtime: BackendReference,
  nonce: string,
): Promise<void> {
  await backend.writeFile(runtime, GENERATION_PATH, new TextEncoder().encode(nonce).buffer, {
    createParents: true,
    overwrite: true,
  });
}

/**
 * Probe the nonce. Never throws: this runs on the liveness path, and a throw
 * here would recreate the blackhole it exists to prevent.
 *
 * ONE call carries the whole probe, and that is the design. Listing
 * `GENERATION_DIR` makes the witness and the answer the SAME observation: the
 * evidence that the container is alive and serving is a listing OF the very
 * directory the nonce lives in, so there is no gap between what was
 * corroborated and what was concluded.
 *
 * The property, stated exactly (this comment has been wrong in both directions
 * before — once claiming a closed hole that was open, once a residual that was
 * closed):
 *
 *   `absent` is reachable ONLY when `listDirectory` ANSWERED. Its contract is
 *   answers-or-throws — no null arm, no not-found mapping, no consulting
 *   `isPathNotFound`'s regex over raw SDK prose — so every failure, of every
 *   kind, lands on `unreadable`. A container that cannot serve the listing
 *   therefore cannot produce a reset verdict at all. There is no error shape
 *   anywhere on this path that gets interpreted as an absence.
 *
 * That is why `absent` may be believed: the container answered for the nonce's
 * own directory and the nonce was not in it. A false `sandbox_reset` tells a
 * model its work is lost when it is not — worse than the under-informative
 * `no_liveness` that `unreadable` degrades to, which is why every ambiguity
 * resolves that way.
 *
 * `readFile`'s error shape is NOT evidence and is not read as any: the fake
 * raises `provider_transient`/"fake_file_not_found" and the real Cloudflare
 * backend funnels every SDK throw through `guard()` -> `toComputeError` onto
 * the same arm, with only raw SDK prose to tell a missing file from a broken
 * container. A failed read is `unreadable`, never an absence.
 */
export async function readGeneration(
  backend: ComputeBackend,
  runtime: BackendReference,
): Promise<GenerationProbe> {
  let entries: DirEntry[];
  try {
    entries = await backend.listDirectory(runtime, GENERATION_DIR);
  } catch {
    return { kind: "unreadable" };
  }
  const entry = entries.find((candidate) => candidate.name === GENERATION_NAME);
  // The container served a listing of the directory the nonce lives in, and the
  // nonce is not in it: the filesystem was wiped. Positive evidence, not an
  // inference from an error shape.
  if (!entry) return { kind: "absent" };
  // A directory/symlink/socket where the nonce should be is not something to
  // reason about — refuse to call it either a generation or a reset.
  if (entry.type !== "file") return { kind: "unreadable" };
  try {
    const result = await backend.readFile(runtime, GENERATION_PATH, GENERATION_MAX_BYTES);
    const nonce = new TextDecoder().decode(result.bytes).trim();
    // Present but empty: a torn write, not a reset. Unknown is the safe read.
    return nonce.length > 0 ? { kind: "found", nonce } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}
