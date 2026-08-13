import { platformCapabilities } from "../../edition";
import type { Env } from "../../env";
import type { BackendProcessReference, BackendReference, ComputeSpec } from "../backend";
import { SPRITES_PROFILE_MEMORY_MB, SpritesComputeBackend } from "./sprites";
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
const SMOKE_SUBDIR = "/workspace/.nadi-sprites-smoke-dir";
/** Written just before the recoverable release; must survive hibernate/wake. */
const SURVIVOR = "/workspace/.nadi-sprites-smoke-survivor.bin";
/** The byte pattern both the round-trip and the survivor file carry. */
const ROUNDTRIP_BYTES = [0, 1, 2, 255, 254, 10, 13, 65, 66, 67, 200];
/**
 * Long enough to pass the provider's ~30s idle hibernation threshold. Without
 * it the recovery step reacquires a sprite that never went to sleep, so
 * "wakes on the first API call" would be asserted by a test that never
 * hibernated anything.
 */
const HIBERNATE_IDLE_MS = 45_000;
/** ~256KB of stdout, to catch WS message coalescing/splitting (see step 6f). */
const LARGE_PAYLOAD_BYTES = 262_144;
/** Base64 of `LARGE_PAYLOAD_BYTES` zero bytes: 349528 chars, all `A` bar `==`. */
const LARGE_PAYLOAD_BASE64_LENGTH = Math.ceil(LARGE_PAYLOAD_BYTES / 3) * 4;
/**
 * The server's replay cap: a session that had ALREADY EXITED when we attached
 * is served from a recorded history truncated to exactly this many bytes
 * (`fast_path … history_len=65536` in its debug frames). See step 6g.
 */
const FAST_PATH_REPLAY_CAP_BYTES = 65_536;
/**
 * How long step 6f's command stalls before producing output, so the socket is
 * attached before the command finishes and the server streams it live
 * (`normal_path`) instead of replaying a truncated history.
 */
const STREAMING_DELAY_SECS = 2;
/** Step 4b's budget for an 8-second background command to be observed finished. */
const PROCESS_SETTLE_TIMEOUT_MS = 40_000;
const PROCESS_SETTLE_POLL_MS = 2_000;

export async function runSpritesSmoke(env: Env): Promise<SpritesSmokeReport> {
  const apiKey = env.SPRITES_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      steps: [{ step: "0. SPRITES_API_KEY present", ok: false, detail: "not set", ms: 0 }],
    };
  }

  // Same resolution as `compute/registry.ts` — the exec upgrade's scheme is a
  // property of the runtime, and a smoke that dialled the other one would
  // exercise a path production never takes. (The `listSprites` probe below is
  // REST-only and unaffected.)
  const client = createSpritesClient({
    apiKey,
    execUpgradeScheme: platformCapabilities(env).wsSchemeUpgrade ? "ws" : "http",
  });
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

  // 0. The connection-test probe, verified nowhere else: Settings → "Test
  // connection" for sprites calls exactly this (`listSprites(1)` on a fresh
  // client) and creates NOTHING. Run it BEFORE any sprite exists, so a wrapper
  // that mis-parses the list body cannot be rescued by this run's own sprite.
  await timed("0. listSprites(1) — the connection-test probe (creates nothing)", async () => {
    const listed = await createSpritesClient({ apiKey }).listSprites(1);
    if (!Array.isArray(listed.names)) {
      throw new Error(
        `listSprites did not parse into {names: string[]}: ${JSON.stringify(listed)}`,
      );
    }
    return `parsed; names.length=${listed.names.length} (maxResults=1)`;
  });

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
      if (
        r.exitCode !== 0 ||
        !r.stdout.includes(SMOKE_ENV_VALUE) ||
        !r.stdout.includes("/workspace")
      ) {
        throw new Error(
          `exitCode=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
        );
      }
      return `exitCode=0 stdout=${JSON.stringify(r.stdout)}`;
    });

    // 2b. `setMemoryPolicy` for the OTHER profile, against a live sprite. The
    // acquire above only proved the `small` limit is accepted; `medium` is a
    // different number on the same route, and a 4xx here (an unsupported limit,
    // a plan cap) would otherwise only ever be discovered by a user picking the
    // medium profile in production.
    await timed(`2b. setMemoryPolicy(medium = ${SPRITES_PROFILE_MEMORY_MB.medium}MB)`, async () => {
      if (!runtime) throw new Error("no runtime acquired");
      await client.setMemoryPolicy(spriteNameOf(runtime), SPRITES_PROFILE_MEMORY_MB.medium);
      // Restore the profile the rest of the run was acquired with.
      await client.setMemoryPolicy(spriteNameOf(runtime), SPRITES_PROFILE_MEMORY_MB.small);
      return `medium limit accepted; restored to small (${SPRITES_PROFILE_MEMORY_MB.small}MB)`;
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
        throw new Error(
          `exitCode=${r.exitCode} http_code=${JSON.stringify(code)} stderr=${JSON.stringify(r.stderr)}`,
        );
      }
      return `http_code=${code}`;
    });

    // 3b. Everything else is denied — proves the allow+deny-* policy actually
    // fences egress, not just that the allow rule works.
    await timed(
      "3b. egress denied (curl --max-time 10 https://example.com must fail)",
      async () => {
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
      },
    );

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

    // 4b. Disconnect-survival + the sentinel-file design: the socket is long
    // gone, so everything below is read fresh from the sprite.
    //
    // POLLED, not a single read after a fixed sleep. `sleep 8` does not reliably
    // finish within 8 s of wall-clock on the caller's side: a sprite nobody is
    // talking to slows down (it hibernates on idle, and waking is implicit on
    // the next API call), so the same process observed at +12 s by a poller that
    // kept it awake was still `running` at +15 s after a silent wait. The
    // ASSERTION is unchanged — it must reach `exited 0` with `done` on stdout —
    // but the deadline is generous and the settle time is reported, because that
    // latency is the observation worth keeping. Production polls too
    // (`ThreadComputeService.refreshProcessStatus`); a one-shot read after a
    // fixed sleep was asserting a latency guarantee the provider never gave.
    await timed("4b. sleep 8 settles: exited 0, stdout has 'done'", async () => {
      if (!runtime || !sleepProcess) throw new Error("no runtime/process");
      const live: BackendReference = runtime;
      const proc: BackendProcessReference = sleepProcess;
      const startedAt = Date.now();
      let status = await backend.getProcessStatus(live, proc);
      while (status.status === "running" && Date.now() - startedAt < PROCESS_SETTLE_TIMEOUT_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_SETTLE_POLL_MS));
        status = await backend.getProcessStatus(live, proc);
      }
      if (status.status !== "exited" || status.exitCode !== 0) {
        throw new Error(
          `status=${status.status} exitCode=${status.exitCode} after ${Date.now() - startedAt}ms`,
        );
      }
      const out = await backend.readProcessOutput(live, proc);
      if (!(out.stdout ?? "").includes("done")) {
        throw new Error(`stdout missing 'done': ${JSON.stringify(out.stdout)}`);
      }
      return `status=exited exitCode=0 after ${Date.now() - startedAt}ms of polling; stdout=${JSON.stringify(out.stdout)}`;
    });

    // 5a. Start a long process to kill.
    let killProcess: BackendProcessReference | null = null;
    await timed("5a. startProcess (sleep 300)", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const started = await backend.startProcess(runtime, {
        command: "sleep 300",
        timeoutMs: 600_000,
      });
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
          throw new Error(
            `still running after kill: stopProcess resolved ${JSON.stringify(stopResult)}`,
          );
        }
        const shape =
          status.status === "failed"
            ? "no rc file was written (wrapper never got to record an exit)"
            : `an rc file WAS written (exitCode=${status.exitCode}, e.g. 137 = 128+SIGKILL)`;
        return `stopProcess resolved ${JSON.stringify(stopResult)}; getProcessStatus after kill = ${JSON.stringify(status)} — ${shape}`;
      },
    );

    // 5c. The OTHER signal path. `stopProcess` maps kill/terminate/interrupt to
    // SIGKILL/SIGTERM/SIGINT, and only SIGKILL was exercised above — a provider
    // that rejects or ignores a non-KILL signal name would go unnoticed.
    await timed("5c. stopProcess(terminate) sends SIGTERM and the process stops", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const started = await backend.startProcess(runtime, {
        command: "sleep 300",
        timeoutMs: 600_000,
      });
      if (started.status !== "running") {
        throw new Error(`expected running right after starting sleep 300, got ${started.status}`);
      }
      const stopResult = await backend.stopProcess(runtime, started.process, "terminate");
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      const status = await backend.getProcessStatus(runtime, started.process);
      if (status.status === "running") {
        throw new Error(
          `still running after SIGTERM: stopProcess resolved ${JSON.stringify(stopResult)}`,
        );
      }
      return `stopProcess(terminate) resolved ${JSON.stringify(stopResult)}; status after = ${JSON.stringify(status)}`;
    });

    // 5d. stdin: `startProcess` writes it to a sentinel file and redirects the
    // wrapper's stdin from there. Nothing else in this run proves that file is
    // written before the wrapper launches, or that the redirect lands.
    await timed(
      "5d. startProcess with stdin (cat echoes it back through the out sentinel)",
      async () => {
        if (!runtime) throw new Error("no runtime acquired");
        const live: BackendReference = runtime;
        const payload = "nadi-sprites-smoke-stdin";
        const started = await backend.startProcess(live, {
          command: "cat",
          stdin: `${payload}\n`,
          timeoutMs: 60_000,
        });
        const output =
          started.status === "exited"
            ? { stdout: started.stdout, stderr: started.stderr }
            : await (async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
                return backend.readProcessOutput(live, started.process);
              })();
        if (!(output.stdout ?? "").includes(payload)) {
          throw new Error(
            `stdin did not reach the process: status=${started.status} stdout=${JSON.stringify(output.stdout)}`,
          );
        }
        return `stdin round-tripped (status=${started.status}, stdout=${JSON.stringify(output.stdout)})`;
      },
    );

    // 6. File round-trip: the /fs [assumed] shapes.
    await timed("6a. writeFile -> readFile bytes identical", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      const src = new Uint8Array(ROUNDTRIP_BYTES);
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

    // 6c also probes the entry TYPE field: `listDirectory` reads each entry's
    // `type` string (`directory`/`file`/`symlink`), and a provider that renamed
    // or dropped it would report every subdirectory as a file — silently, with
    // no error, in every directory listing the model ever sees. A real
    // subdirectory is the only thing that can catch it.
    await timed(
      "6c. listDirectory shows the file, and a subdirectory as type=directory",
      async () => {
        if (!runtime) throw new Error("no runtime acquired");
        await backend.createDirectory(runtime, SMOKE_SUBDIR);
        const entries = await backend.listDirectory(runtime, "/workspace");
        const name = ROUNDTRIP_SRC.split("/").pop() as string;
        if (!entries.some((entry) => entry.name === name)) {
          throw new Error(`entry not found; listing=${JSON.stringify(entries.map((e) => e.name))}`);
        }
        const dirName = SMOKE_SUBDIR.split("/").pop() as string;
        const dirEntry = entries.find((entry) => entry.name === dirName);
        if (dirEntry?.type !== "directory") {
          throw new Error(
            `subdirectory ${dirName} reported type=${dirEntry?.type ?? "missing"} — the is-dir field ` +
              `is not being read; listing=${JSON.stringify(entries)}`,
          );
        }
        return `listing includes ${name} and ${dirName} (type=directory); ${entries.length} entries total`;
      },
    );

    // 6c2. The no-overwrite contract, asserted as an expected FAILURE: writing
    // over an existing path without `overwrite` must reject. This is the guard
    // `ComputeFileService` leans on to avoid clobbering a file it did not read.
    await timed("6c2. writeFile({overwrite:false}) onto an existing path must reject", async () => {
      if (!runtime) throw new Error("no runtime acquired");
      let detail: string | null = null;
      try {
        await backend.writeFile(runtime, ROUNDTRIP_SRC, textBuffer("CLOBBER"), {
          createParents: false,
          overwrite: false,
        });
      } catch (error) {
        detail = message(error);
      }
      if (detail === null) {
        throw new Error(
          "write SUCCEEDED over an existing path with overwrite:false — clobber risk",
        );
      }
      const read = await backend.readFile(runtime, ROUNDTRIP_SRC, 1_000);
      if (read.bytes.byteLength !== 11) {
        throw new Error(`existing file was modified: ${read.bytes.byteLength} bytes`);
      }
      return `rejected as required (${detail}); existing file untouched (11 bytes)`;
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
        throw new Error(
          `dest=${JSON.stringify(destInfo)} src(should be gone)=${JSON.stringify(srcInfo)}`,
        );
      }
      return `destination replaced (size=${destInfo.size}); source path now absent`;
    });

    // 6d2. The move side of the same contract: `movePath` must refuse an
    // existing destination unless told to overwrite. Asserted after 6d, so the
    // destination is known to exist.
    await timed(
      "6d2. movePath(overwrite:false) onto an existing destination must reject",
      async () => {
        if (!runtime) throw new Error("no runtime acquired");
        const scratch = `${SMOKE_SUBDIR}/move-source.bin`;
        await backend.writeFile(runtime, scratch, textBuffer("NEW"), {
          createParents: true,
          overwrite: true,
        });
        let detail: string | null = null;
        try {
          await backend.movePath(runtime, scratch, ROUNDTRIP_DEST, false);
        } catch (error) {
          detail = message(error);
        }
        if (detail === null) {
          throw new Error("move SUCCEEDED onto an existing destination with overwrite:false");
        }
        const destInfo = await backend.inspectPath(runtime, ROUNDTRIP_DEST);
        const srcInfo = await backend.inspectPath(runtime, scratch);
        if (destInfo?.size !== 11 || srcInfo === null) {
          throw new Error(
            `refused move was not a no-op: dest=${JSON.stringify(destInfo)} src=${JSON.stringify(srcInfo)}`,
          );
        }
        await backend.deletePath(runtime, scratch);
        return `rejected as required (${detail}); destination and source both intact`;
      },
    );

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
    //
    // The leading `sleep` is load-bearing, and is what this step exists for:
    // it guarantees the socket is attached BEFORE any output exists, so the
    // server streams the run live (`normal_path`) across many frames. Without
    // it the command can finish inside the ~25ms upgrade round-trip, and the
    // server then REPLAYS a history capped at 64KiB — an integrity assertion
    // over that path can never pass, and says nothing about framing. Step 6g
    // covers the replay cap deliberately.
    await timed(
      "6f. WS exec framing under >=256KB payload, streamed (byte-count + content integrity)",
      async () => {
        if (!runtime) throw new Error("no runtime acquired");
        const r = await backend.runCommand(runtime, {
          command: `sleep ${STREAMING_DELAY_SECS}; head -c ${LARGE_PAYLOAD_BYTES} /dev/zero | base64 -w0`,
          timeoutMs: 30_000,
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`,
          );
        }
        const stdout = r.stdout.trim();
        if (stdout.length !== LARGE_PAYLOAD_BASE64_LENGTH) {
          throw new Error(
            `byte count mismatch: got ${stdout.length} expected ${LARGE_PAYLOAD_BASE64_LENGTH} — ` +
              (stdout.length === FAST_PATH_REPLAY_CAP_BYTES
                ? `this is the ${FAST_PATH_REPLAY_CAP_BYTES}-byte fast_path replay cap, so the sleep ` +
                  `did not keep us on the streaming path`
                : `frame coalescing/splitting likely corrupted or truncated the stream`),
          );
        }
        if (!/^A+==$/.test(stdout)) {
          throw new Error(
            `payload content corrupted (expected all-'A' base64 of zero bytes with a trailing '=='); ` +
              `head=${JSON.stringify(stdout.slice(0, 40))} tail=${JSON.stringify(stdout.slice(-40))}`,
          );
        }
        return `streamed (normal_path): stdout length=${stdout.length} matches expected ${LARGE_PAYLOAD_BASE64_LENGTH}; content verified all-'A' with trailing '==' (no coalescing/splitting detected)`;
      },
    );

    // 6g. KNOWN LIMITATION PROBE, not a feature test. The same command with no
    // leading sleep races the upgrade: if it exits first, the server serves a
    // RECORDED history capped at exactly 65536 bytes (`fast_path …
    // history_len=65536` in its debug frames) and reports exit 0 — `runCommand`
    // silently truncates. If we win the race it streams (`normal_path`) and
    // everything arrives. Both are known-good today, so BOTH are accepted and
    // the observed one is reported; anything else is a change in provider
    // behaviour and fails. Documented at `execCollect` and in
    // docs/operations/sprites.md.
    await timed(
      `6g. KNOWN LIMITATION: fast-path replay caps runCommand output at ${FAST_PATH_REPLAY_CAP_BYTES} bytes`,
      async () => {
        if (!runtime) throw new Error("no runtime acquired");
        const r = await backend.runCommand(runtime, {
          command: `head -c ${LARGE_PAYLOAD_BYTES} /dev/zero | base64 -w0`,
          timeoutMs: 30_000,
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`,
          );
        }
        const length = r.stdout.trim().length;
        if (length === FAST_PATH_REPLAY_CAP_BYTES) {
          // The cut must be VISIBLE. `execCollect` reads the server's own
          // `fast_path … history_len=65536` debug frame and the backend
          // propagates it here, so a truncated run that still claimed complete
          // output would be the silent-wrong-answer this whole step is about.
          if (r.stdoutTruncated !== true) {
            throw new Error(
              `truncated to ${length} bytes but stdoutTruncated=${String(r.stdoutTruncated)} — ` +
                `the fast_path replay cap was NOT detected, so the model would read a halved ` +
                `stdout as complete`,
            );
          }
          return (
            `fast_path replay: got ${length} of ${LARGE_PAYLOAD_BASE64_LENGTH} bytes with exitCode=0, ` +
            `and stdoutTruncated=true — the documented 64KiB truncation, now DETECTED from the server's ` +
            `debug frame. Large output must still go through startProcess + readProcessOutput.`
          );
        }
        if (length === LARGE_PAYLOAD_BASE64_LENGTH) {
          if (r.stdoutTruncated === true) {
            throw new Error(
              `all ${length} bytes arrived but stdoutTruncated=true — a FALSE truncation signal ` +
                `would make the model discard complete output`,
            );
          }
          return (
            `normal_path this run: the command did not finish inside the upgrade round-trip, so all ` +
            `${length} bytes streamed and stdoutTruncated is false. The cap is still real (see 6f's ` +
            `comment); which path a fast command takes is a race, which is why this step accepts both.`
          );
        }
        throw new Error(
          `unrecognised length ${length}: neither the full ${LARGE_PAYLOAD_BASE64_LENGTH} bytes nor the ` +
            `known ${FAST_PATH_REPLAY_CAP_BYTES}-byte replay cap — provider behaviour has CHANGED here`,
        );
      },
    );

    // 7. Hibernate/wake reuse: recoverable release is a no-op provider call
    // (hibernation is automatic); acquiring with the recovery reference must
    // reuse the same sprite, and its filesystem must still hold what step 6d
    // wrote.
    let recoveryReference: BackendReference | null = null;
    await timed(
      "7a. release(recoverable) returns a recovery reference (no provider call)",
      async () => {
        if (!runtime) throw new Error("no runtime acquired");
        // Step 6e deleted the round-trip file, so the survivor is written here —
        // reading a path a previous step removed would have made 7c fail for a
        // reason that has nothing to do with hibernation.
        await backend.writeFile(runtime, SURVIVOR, toArrayBuffer(new Uint8Array(ROUNDTRIP_BYTES)), {
          createParents: true,
          overwrite: true,
        });
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
        recoveryReference = recovery;
        return "recovery reference held; no provider call was made";
      },
    );

    // 7b. Idle long enough to actually hibernate. Its own step so a slow run is
    // attributable to the deliberate wait rather than to a sluggish provider —
    // and without it, 7c would reacquire a sprite that never slept, which
    // proves nothing about waking one that did.
    await timed(
      `7b. idle ${HIBERNATE_IDLE_MS / 1000}s so the sprite hibernates (~30s idle)`,
      async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, HIBERNATE_IDLE_MS));
        return `waited ${HIBERNATE_IDLE_MS}ms with no API call in flight`;
      },
    );

    await timed("7c. acquire(recovery) wakes the hibernated sprite; file survives", async () => {
      if (!recoveryReference) throw new Error("no recovery reference held");
      runtime = await backend.acquire(spec, recoveryReference);
      const read = await backend.readFile(runtime, SURVIVOR, 1_000);
      const back = new Uint8Array(read.bytes);
      const expected = new Uint8Array(ROUNDTRIP_BYTES);
      if (!bytesEqual(back, expected)) {
        throw new Error(`file did not survive hibernate/wake: bytes=${JSON.stringify([...back])}`);
      }
      return `file survived hibernate/wake round trip (${back.length} bytes intact, same sprite reused)`;
    });

    // 9. backgrounded work under a hold actually EXECUTES while idle, AND the
    // hold is actually gone once the command finishes.
    //
    // The hibernate/wake step above only asserts a FILE survives, which a VM at
    // a 2% duty cycle also satisfies — that is why the progress half of this is
    // a separate assertion, of a PROCESS actually making progress with no
    // traffic keeping it awake. The release half exists because round 1 of
    // this feature shipped a hold that was NEVER actually releasable (it
    // targeted a hold id that never existed) and a refresher that could
    // resurrect a released hold for up to 5 minutes after completion — a live
    // duty-cycle measurement alone cannot see either defect, since both leave
    // the HELD run itself indistinguishable from a correctly-released one.
    await timed(
      "9. held background command progresses while idle, and releases its hold",
      async () => {
        if (!runtime) throw new Error("no runtime acquired");
        if (!backend.workHold) throw new Error("backend declares no workHold");
        const started = await backend.startProcess(runtime, {
          command: "for i in $(seq 1 20); do date +%s >> /tmp/smoke_beat; sleep 3; done",
          timeoutMs: 120_000,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 60_000)); // >> the ~30s hibernation threshold, with no traffic
        const beats = await backend.readFile(runtime, "/tmp/smoke_beat", 10_000);
        const count = new TextDecoder().decode(beats.bytes).trim().split("\n").length;
        if (count < 15)
          throw new Error(`held command starved: ${count} beats in 60s, expected ~20`);

        // The loop is ~60s of work total; let the last iteration and the
        // wrapper's own rc-write + release land.
        let status = await backend.getProcessStatus(runtime, started.process);
        for (let attempt = 0; attempt < 15 && status.status === "running"; attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
          status = await backend.getProcessStatus(runtime, started.process);
        }
        if (status.status !== "exited") {
          throw new Error(
            `command did not settle in time to check the hold: status=${status.status}`,
          );
        }

        // The wrapper releases its own hold right after the rc write. A SECOND
        // `DELETE` on an already-gone Tasks-API entry 404s, so `curl -sf` exits
        // non-zero — a ZERO exit here means the hold is STILL there, i.e. the
        // release never ran (or the refresher resurrected it).
        const releaseAgain = await backend.runCommand(runtime, {
          command: backend.workHold.releaseFor(started.process),
          timeoutMs: 10_000,
        });
        if (releaseAgain.exitCode === 0) {
          throw new Error("hold still present after the command completed — release did not run");
        }
        return (
          `${count} beats in 60s idle (unheld baseline is 1); ` +
          `hold confirmed released after completion (second DELETE exit ${releaseAgain.exitCode})`
        );
      },
    );
  } finally {
    // 8. Never leak a sprite — they bill storage forever with no auto-destroy.
    const started = Date.now();
    if (runtime) {
      try {
        await backend.destroy(runtime);
        push("8. destroy (finally)", true, "sprite deleted", Date.now() - started);
      } catch (error) {
        push(
          "8. destroy (finally)",
          false,
          `POSSIBLE LEAKED SPRITE — ${message(error)}`,
          Date.now() - started,
        );
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
