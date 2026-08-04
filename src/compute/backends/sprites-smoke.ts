import type { Env } from "../../env";
import type { BackendProcessReference, BackendReference, ComputeSpec } from "../backend";
import { SpritesComputeBackend } from "./sprites";
import { createSpritesClient } from "./sprites-client";

/**
 * The live-smoke ship gate for the sprites.dev compute provider. Everything
 * here runs INSIDE the Worker (deployed or `wrangler dev`), never Node —
 * that is deliberate: it exercises the exact fetch-upgrade WebSocket path
 * production uses (`sprites-client.ts`'s `execCollect`/`execDetached`), which
 * a Node script cannot reproduce.
 *
 * `SpritesComputeBackend`'s process bookkeeping and `/fs` wire shapes were
 * built against the vendor's JS SDK, not a live probe (see the **[assumed]**
 * markers in `sprites.ts`/`sprites-client.ts`). Every step here is either an
 * `assertion` a wrong assumption FAILS, or an `observation` that just needs
 * the real answer written down — either way, nothing is invented if the
 * provider disagrees with the guess.
 */
export interface SpritesSmokeStep {
  step: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

export interface SpritesSmokeReport {
  ok: boolean;
  steps: SpritesSmokeStep[];
}

const SMOKE_ENV_VALUE = "1";
const ROUNDTRIP_SRC = "/workspace/.nadi-sprites-smoke-roundtrip.bin";
const ROUNDTRIP_DEST = "/workspace/.nadi-sprites-smoke-roundtrip-dest.bin";
/** ~256KB of stdout, to catch WS message coalescing/splitting (see step 6f). */
const LARGE_PAYLOAD_BYTES = 262_144;

export async function runSpritesSmoke(env: Env): Promise<SpritesSmokeReport> {
  const apiKey = env.SPRITES_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      steps: [{ step: "0. SPRITES_API_KEY present", ok: false, detail: "not set", ms: 0 }],
    };
  }

  const client = createSpritesClient({ apiKey });
  const backend = new SpritesComputeBackend({ client });

  const steps: SpritesSmokeStep[] = [];
  const push = (step: string, ok: boolean, detail: string | undefined, ms: number): void => {
    steps.push({ step, ok, ...(detail !== undefined ? { detail } : {}), ms });
  };
  /** Every step is try/caught here — a thrown error becomes ok:false, never
   * aborts the run, and NEVER carries `apiKey`/`DEBUG_TOKEN` (the caught
   * error is only ever a `ComputeError`/`Error` message from this file's own
   * calls, none of which echo the key). */
  const timed = async (step: string, fn: () => Promise<string>): Promise<void> => {
    const started = Date.now();
    try {
      const detail = await fn();
      push(step, true, detail, Date.now() - started);
    } catch (error) {
      push(step, false, message(error), Date.now() - started);
    }
  };

  const spec: ComputeSpec = {
    environmentId: "sprites:small",
    profile: "small",
    workspaceRoot: "/workspace",
    env: { SMOKE: SMOKE_ENV_VALUE },
    maxProcessRuntimeMs: 600_000,
    allowedHosts: ["github.com", "*.githubusercontent.com"],
  };

  let runtime: BackendReference | null = null;

  try {
    // 1. acquire: create + memory policy + network policy + mkdir /workspace.
    // `prepare()` awaits setMemoryPolicy then setNetworkPolicy then the mkdir,
    // throwing on any non-ok response — so `acquire` resolving at all is
    // already positive evidence all three succeeded; inspectPath is the
    // independent confirmation of the last one.
    await timed("1. acquire (memory + network policy + mkdir /workspace)", async () => {
      runtime = await backend.acquire(spec);
      const info = await backend.inspectPath(runtime, "/workspace");
      if (info?.type !== "directory") {
        throw new Error(`acquire resolved but /workspace type=${info?.type ?? "missing"}`);
      }
      return (
        "sprite created; setMemoryPolicy + setNetworkPolicy did not throw (both are awaited, " +
        `in-band failures reject); /workspace present (type=${info.type})`
      );
    });

    // 2. WS exec framing end-to-end (the [assumed] frame protocol).
    await timed("2. runCommand exec framing (echo $SMOKE && pwd)", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const r = await backend.runCommand(runtime, {
        command: "echo $SMOKE && pwd",
        cwd: "/workspace",
        timeoutMs: 30_000,
      });
      if (r.exitCode !== 0 || !r.stdout.includes(SMOKE_ENV_VALUE) || !r.stdout.includes("/workspace")) {
        throw new Error(
          `exitCode=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
        );
      }
      return `exitCode=0 stdout=${JSON.stringify(r.stdout)}`;
    });

    // 3a. Allow-listed egress passes.
    await timed("3a. egress allowed (curl https://github.com)", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const r = await backend.runCommand(runtime, {
        command: "curl -sS -o /dev/null -w '%{http_code}' https://github.com",
        timeoutMs: 30_000,
      });
      const code = r.stdout.trim();
      if (r.exitCode !== 0 || !["200", "301"].includes(code)) {
        throw new Error(`exitCode=${r.exitCode} http_code=${JSON.stringify(code)} stderr=${JSON.stringify(r.stderr)}`);
      }
      return `http_code=${code}`;
    });

    // 3b. Everything else is denied — proves the allow+deny-* policy actually
    // fences egress, not just that the allow rule works.
    await timed("3b. egress denied (curl --max-time 10 https://example.com must fail)", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const r = await backend.runCommand(runtime, {
        command: "curl --max-time 10 https://example.com",
        timeoutMs: 30_000,
      });
      if (r.exitCode === 0) {
        throw new Error(
          `curl to a non-allow-listed host SUCCEEDED (exit 0) — egress is NOT fenced; ` +
            `stdout=${JSON.stringify(r.stdout.slice(0, 200))}`,
        );
      }
      return `curl failed as required: exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`;
    });

    // 4a. Detachable session survives disconnect; sid-in-command matching in
    // listSessions is what getProcessStatus's "running" answer depends on.
    // FLAGGED UNKNOWN #1: the raw session list is recorded verbatim below —
    // the backend matches sessions by substring on `command`, so a
    // truncated/absent echo here means every long-running process would
    // wrongly report "failed".
    let sleepProcess: BackendProcessReference | null = null;
    await timed("4a. startProcess (sleep 8) + immediate status [raw session list]", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const started = await backend.startProcess(runtime, {
        command: "sleep 8; echo done",
        timeoutMs: 60_000,
      });
      sleepProcess = started.process;
      const status = await backend.getProcessStatus(runtime, started.process);
      const rawSessions = await client.listSessions(spriteNameOf(runtime));
      if (status.status !== "running") {
        throw new Error(
          `expected running immediately after start, got ${status.status} ` +
            `(startProcess itself returned status=${started.status}); raw listSessions=${JSON.stringify(rawSessions)}`,
        );
      }
      return `status=running; raw listSessions=${JSON.stringify(rawSessions)}`;
    });

    // 4b. Disconnect-survival + the sentinel-file design: wait past the sleep,
    // then read state fresh (no socket was held open across the wait).
    await timed("4b. sleep 8 settles: exited 0, stdout has 'done'", async () => {
      if (!runtime || !sleepProcess) throw new Error("no runtime/process");
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      const status = await backend.getProcessStatus(runtime, sleepProcess);
      if (status.status !== "exited" || status.exitCode !== 0) {
        throw new Error(`status=${status.status} exitCode=${status.exitCode}`);
      }
      const out = await backend.readProcessOutput(runtime, sleepProcess);
      if (!(out.stdout ?? "").includes("done")) {
        throw new Error(`stdout missing 'done': ${JSON.stringify(out.stdout)}`);
      }
      return `status=exited exitCode=0 stdout=${JSON.stringify(out.stdout)}`;
    });

    // 5a. Start a long process to kill.
    let killProcess: BackendProcessReference | null = null;
    await timed("5a. startProcess (sleep 300)", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const started = await backend.startProcess(runtime, { command: "sleep 300", timeoutMs: 600_000 });
      killProcess = started.process;
      if (started.status !== "running") {
        throw new Error(`expected running right after starting sleep 300, got ${started.status}`);
      }
      return `started, status=${started.status}`;
    });

    // 5b. Kill endpoint + signal mapping. FLAGGED UNKNOWN #2: after a SIGKILL,
    // does getProcessStatus answer "failed" (no rc file — the wrapper never
    // got to run `printf %s "$?" > rc`) or "exited" with an rc (e.g. 137,
    // written by a shell that survives its child's kill)? sprites.ts handles
    // both arms; this records which one the live provider actually returns.
    await timed(
      "5b. stopProcess(kill) then status is not running [post-SIGKILL state shape]",
      async () => {
        if (!runtime || !killProcess) throw new Error("no runtime/process");
        const stopResult = await backend.stopProcess(runtime, killProcess, "kill");
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        const status = await backend.getProcessStatus(runtime, killProcess);
        if (status.status === "running") {
          throw new Error(`still running after kill: stopProcess resolved ${JSON.stringify(stopResult)}`);
        }
        const shape =
          status.status === "failed"
            ? "no rc file was written (wrapper never got to record an exit)"
            : `an rc file WAS written (exitCode=${status.exitCode}, e.g. 137 = 128+SIGKILL)`;
        return `stopProcess resolved ${JSON.stringify(stopResult)}; getProcessStatus after kill = ${JSON.stringify(status)} — ${shape}`;
      },
    );

    // 6. File round-trip: the /fs [assumed] shapes.
    await timed("6a. writeFile -> readFile bytes identical", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const src = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 65, 66, 67, 200]);
      await backend.writeFile(runtime, ROUNDTRIP_SRC, toArrayBuffer(src), {
        createParents: true,
        overwrite: true,
      });
      const read = await backend.readFile(runtime, ROUNDTRIP_SRC, 1_000_000);
      const back = new Uint8Array(read.bytes);
      if (!bytesEqual(src, back)) {
        throw new Error(`bytes differ: wrote ${src.length} read ${back.length}`);
      }
      return `bytes identical (${src.length} bytes)`;
    });

    await timed("6b. inspectPath(file) reports type + size", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const info = await backend.inspectPath(runtime, ROUNDTRIP_SRC);
      if (info?.type !== "file" || info.size !== 11) {
        throw new Error(`info=${JSON.stringify(info)}`);
      }
      return `type=file size=${info.size}`;
    });

    await timed("6c. listDirectory shows the file", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const entries = await backend.listDirectory(runtime, "/workspace");
      const name = ROUNDTRIP_SRC.split("/").pop() as string;
      if (!entries.some((entry) => entry.name === name)) {
        throw new Error(`entry not found; listing=${JSON.stringify(entries.map((e) => e.name))}`);
      }
      return `listing includes ${name} (${entries.length} entries total)`;
    });

    await timed("6d. movePath(overwrite) onto an existing destination", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      await backend.writeFile(runtime, ROUNDTRIP_DEST, textBuffer("OLD"), {
        createParents: true,
        overwrite: true,
      });
      await backend.movePath(runtime, ROUNDTRIP_SRC, ROUNDTRIP_DEST, true);
      const destInfo = await backend.inspectPath(runtime, ROUNDTRIP_DEST);
      const srcInfo = await backend.inspectPath(runtime, ROUNDTRIP_SRC);
      if (destInfo?.type !== "file" || destInfo.size !== 11 || srcInfo !== null) {
        throw new Error(`dest=${JSON.stringify(destInfo)} src(should be gone)=${JSON.stringify(srcInfo)}`);
      }
      return `destination replaced (size=${destInfo.size}); source path now absent`;
    });

    await timed("6e. deletePath removes the file", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      await backend.deletePath(runtime, ROUNDTRIP_DEST);
      const info = await backend.inspectPath(runtime, ROUNDTRIP_DEST);
      if (info !== null) throw new Error(`still present: ${JSON.stringify(info)}`);
      return "deleted; inspectPath now null";
    });

    // 6f. FLAGGED UNKNOWN #3: WS exec framing under a real ≥256KB payload.
    // execCollect ASSUMES exactly one frame per WebSocket message (see the
    // comment in sprites-client.ts); a coalesced message would corrupt or
    // truncate stdout mid-stream. Base64 of all-zero bytes is deterministic
    // (every triple → "AAA A", with a fixed tail), so both length AND content
    // are checked — a corruption that preserved length would still be caught.
    await timed("6f. WS exec framing under >=256KB payload (byte-count + content integrity)", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const r = await backend.runCommand(runtime, {
        command: `head -c ${LARGE_PAYLOAD_BYTES} /dev/zero | base64 -w0`,
        timeoutMs: 30_000,
      });
      if (r.exitCode !== 0) {
        throw new Error(`exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
      }
      const stdout = r.stdout.trim();
      const expectedLength = Math.ceil(LARGE_PAYLOAD_BYTES / 3) * 4;
      if (stdout.length !== expectedLength) {
        throw new Error(
          `byte count mismatch: got ${stdout.length} expected ${expectedLength} — frame coalescing/splitting likely corrupted or truncated the stream`,
        );
      }
      if (!/^A+==$/.test(stdout)) {
        throw new Error(
          `payload content corrupted (expected all-'A' base64 of zero bytes with a trailing '=='); ` +
            `head=${JSON.stringify(stdout.slice(0, 40))} tail=${JSON.stringify(stdout.slice(-40))}`,
        );
      }
      return `stdout length=${stdout.length} matches expected ${expectedLength}; content verified all-'A' with trailing '==' (no coalescing/splitting detected)`;
    });

    // 7. Hibernate/wake reuse: recoverable release is a no-op provider call
    // (hibernation is automatic); acquiring with the recovery reference must
    // reuse the same sprite, and its filesystem must still hold what step 6d
    // wrote.
    await timed("7. release(recoverable) -> acquire(recovery) -> file survives", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const recovery = await backend.release(runtime, {
        disposition: "recoverable",
        recoveryTtlMs: 60 * 60 * 1000,
      });
      if (!recovery) throw new Error("recoverable release returned null");
      // Hold the recovery reference in `runtime` IMMEDIATELY, before
      // attempting the reacquire below — `destroy` accepts a recovery
      // reference too, so if `acquire(spec, recovery)` throws (a real
      // transient-failure surface: it re-applies policies + mkdir over the
      // network), the `finally` can still delete the sprite instead of
      // discarding its only reference here and leaking it forever.
      runtime = recovery;
      runtime = await backend.acquire(spec, recovery);
      const read = await backend.readFile(runtime, ROUNDTRIP_DEST, 1_000);
      const back = new Uint8Array(read.bytes);
      const expected = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 65, 66, 67, 200]);
      if (!bytesEqual(back, expected)) {
        throw new Error(`file did not survive hibernate/wake: bytes=${JSON.stringify([...back])}`);
      }
      return `file survived hibernate/wake round trip (${back.length} bytes intact, same sprite reused)`;
    });
  } finally {
    // 8. Never leak a sprite — they bill storage forever with no auto-destroy.
    const started = Date.now();
    if (runtime) {
      try {
        await backend.destroy(runtime);
        push("8. destroy (finally)", true, "sprite deleted", Date.now() - started);
      } catch (error) {
        push("8. destroy (finally)", false, `POSSIBLE LEAKED SPRITE — ${message(error)}`, Date.now() - started);
      }
    } else {
      push(
        "8. destroy (finally)",
        true,
        "no runtime reference held at cleanup time (nothing to destroy)",
        Date.now() - started,
      );
    }
  }

  return { ok: steps.every((s) => s.ok), steps };
}

/** The sprite name backing a runtime reference — needed for the raw
 * `client.listSessions` probe in step 4a, which the backend does not expose. */
function spriteNameOf(reference: BackendReference): string {
  const payload = reference.payload as { spriteName?: unknown };
  if (typeof payload.spriteName !== "string") {
    throw new Error("reference missing spriteName");
  }
  return payload.spriteName;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function textBuffer(value: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(value));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
