import type { BackendReference, ComputeBackend, ComputeSpec } from "../backend";
import type { ComputeProviderReadiness } from "../settings";
import type { CloudflareSandbox } from "./cloudflare-client";
// Imported, not reimplemented: 8f must compare echoes EXACTLY as `existsProbe`
// does, or it can pass on a spelling the backend would reject.
import { stripTrailingSlash } from "./cloudflare";

/**
 * One observation from the live Cloudflare compute smoke run. `ok` reports
 * whether the step's assertion held (or, for pure observations, whether the
 * probe completed); `detail` records WHAT the real provider actually did — this
 * is an instrument, not a pass/fail buzzer, so both possible behaviors of an
 * unsettled contract are written out verbatim.
 */
export interface CloudflareSmokeStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface CloudflareSmokeContext {
  /** The backend under test, constructed DIRECTLY (never via the thread's
   * configured provider — the workspace may be on Daytona). */
  backend: ComputeBackend;
  /** Raw SDK seam resolving the SAME sandbox id as `backend`, for the probes the
   * backend deliberately hides (raw `moveFile`, in-band `{success:false}` vs
   * throw). In production both resolve the one Durable Object behind the id. */
  directSandbox: CloudflareSandbox;
  /** Cloudflare readiness verdict for this workspace (network-unrestricted). */
  readiness: ComputeProviderReadiness;
  /** The id the backend MUST derive (fixed-length; see `deriveSandboxId`). */
  expectedSandboxId: string;
  /** The template id (`cloudflare:small`) the id must NOT be derived from. */
  environmentId: string;
  /** The spec fed to `acquire`; `spec.env` carries a sentinel for the env-reapply
   * check. Contains only endpoint-created markers, never workspace secrets. */
  spec: ComputeSpec;
  /** Injected so a test need not wait on real time. */
  sleep?: (ms: number) => Promise<void>;
}

const SMOKE_ROOT = "/workspace/.nadi-cf-smoke";
const SENTINEL_PATH = "/workspace/.nadi-cf-sentinel";
const ENV_SENTINEL = "NADI_CF_SMOKE";

/**
 * Drive the real Cloudflare Sandbox provider through every claim a fake could
 * only assert. Each step records its own outcome (a thrown error never aborts
 * the run), and a `finally` self-clean destroys the container the run created —
 * a leaked container costs money and shared disk. The orchestration here is what
 * the unit tests exercise against a fake; the SUBJECT MATTER (what the container
 * actually does) is unverifiable off a deployed Worker, which is the whole point.
 */
export async function runCloudflareComputeSmoke(
  ctx: CloudflareSmokeContext,
): Promise<{ steps: CloudflareSmokeStep[] }> {
  const steps: CloudflareSmokeStep[] = [];
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = Math.random().toString(36).slice(2, 8);
  let runtime: BackendReference | null = null;

  const push = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
  };
  /** Assertion step: `fn` throws on failure; a thrown error becomes ok:false. */
  const assert = async (step: string, fn: () => Promise<string>): Promise<void> => {
    try {
      push(step, true, await fn());
    } catch (error) {
      push(step, false, message(error));
    }
  };
  /** Observation step: record whichever of two behaviors occurred; ok:true means
   * the probe was successfully OBSERVED, not that any particular result held. */
  const observe = async (step: string, fn: () => Promise<string>): Promise<void> => {
    try {
      push(step, true, await fn());
    } catch (error) {
      push(step, true, `probe error: ${message(error)}`);
    }
  };

  const execCollect = async (
    command: string,
    stdin?: string,
  ): Promise<{ status: string; exitCode: number | null; stdout: string; stderr: string }> => {
    if (!runtime) throw new Error("no runtime acquired");
    const started = await ctx.backend.startProcess(runtime, {
      command,
      timeoutMs: ctx.spec.maxProcessRuntimeMs,
      ...(stdin !== undefined ? { stdin } : {}),
    });
    let status: { status: string; exitCode?: number } = {
      status: started.status,
      ...(started.exitCode === undefined ? {} : { exitCode: started.exitCode }),
    };
    for (let i = 0; i < 150 && status.status === "running"; i += 1) {
      await sleep(200);
      status = await ctx.backend.getProcessStatus(runtime, started.process);
    }
    const out = await ctx.backend.readProcessOutput(runtime, started.process);
    return {
      status: status.status,
      exitCode: status.exitCode ?? null,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
    };
  };

  try {
    // 1. Readiness reports deployable.
    await assert("1. readiness reports ready", async () => {
      const r = ctx.readiness;
      if (!r.ready) {
        throw new Error(
          `not ready: missingConfig=[${r.missingConfig.join(",")}] unsupported=[${r.unsupported.join(",")}]`,
        );
      }
      return `ready=true missingConfig=[] unsupported=[${r.unsupported.join(",")}]`;
    });

    // 2. Fail-closed egress BEFORE acquiring anything real, so "creates no
    // container" is established by ordering: the throw precedes any resolve.
    {
      const step = "2. fail-closed egress throws policy_rejected (no container)";
      try {
        await ctx.backend.acquire({ ...ctx.spec, allowedHosts: ["blocked.example"] });
        push(
          step,
          false,
          "acquire RESOLVED with a non-empty allowlist — egress is NOT fail-closed",
        );
      } catch (error) {
        const code = errorCode(error);
        push(
          step,
          code === "policy_rejected",
          `threw code=${code ?? "?"} (${message(error)}); ran before any real acquire, so no container was created`,
        );
      }
    }

    // 3. Acquire small; assert the id is per-(workspace,thread), NOT environmentId.
    await assert("3. acquire small derives the (workspace, thread) id", async () => {
      runtime = await ctx.backend.acquire(ctx.spec);
      const sid = referenceSandboxId(runtime);
      if (sid !== ctx.expectedSandboxId) {
        throw new Error(`sandboxId=${sid} expected=${ctx.expectedSandboxId}`);
      }
      return `sandboxId=${sid} (NOT derived from environmentId=${JSON.stringify(ctx.environmentId)}, which is the same for every thread)`;
    });

    // 4. Exec: exact stdout + exit code, plus stdin delivery.
    // LIVE FACT (2026-07-10): the container server appends a trailing newline to
    // captured stdout even for `printf`, which emits none. Compare trimmed. The
    // production connection test in sandbox-settings-routes.ts already trims.
    await assert("4a. exec printf marker (stdout, trailing newline trimmed)", async () => {
      const r = await execCollect("printf nadi-compute-ready");
      if (r.stdout.trim() !== "nadi-compute-ready") {
        throw new Error(`stdout=${JSON.stringify(r.stdout)} exit=${r.exitCode} status=${r.status}`);
      }
      return `stdout matched (trimmed); raw=${JSON.stringify(r.stdout)} exitCode=${r.exitCode}`;
    });
    await assert("4b. exec stdin delivery", async () => {
      const marker = `nadi-stdin-${rand}`;
      const r = await execCollect("cat", marker);
      if (r.stdout.trim() !== marker) {
        throw new Error(`stdin echo stdout=${JSON.stringify(r.stdout)} exit=${r.exitCode}`);
      }
      return `stdin delivered; stdout echoed marker; exitCode=${r.exitCode}`;
    });
    // 4c. Poll a process AFTER it exits, not inline to completion. This is the
    // path the watcher takes for a command that crosses the foreground window,
    // and the one that hung production: the SDK auto-deletes a process record on
    // exit (autoCleanup default true), so a delayed poll got process_missing and
    // lost the output. The backend now starts with autoCleanup:false. execCollect
    // above polls tightly and never crossed this boundary, which is why the bug
    // shipped green.
    await assert("4c. a completed process stays readable after a delay", async () => {
      const started = await ctx.backend.startProcess(runtime!, {
        command: `printf 'delayed-%s' ${rand}`,
        timeoutMs: 30_000,
      });
      await sleep(2_000); // let it exit; the real hang was the poll AFTER exit
      const status = await ctx.backend.getProcessStatus(runtime!, started.process);
      if (status.status === "running") throw new Error("still running after 2s (unexpected)");
      const out = await ctx.backend.readProcessOutput(runtime!, started.process);
      if ((out.stdout ?? "").trim() !== `delayed-${rand}`) {
        throw new Error(
          `post-exit output lost/mismatched: status=${status.status} stdout=${JSON.stringify(out.stdout)}`,
        );
      }
      return `post-exit poll OK: status=${status.status} stdout=${JSON.stringify(out.stdout)}`;
    });

    // 4d. A wrapped completion callback: the command's own exit code and
    // output must win, and the callback's own HTTP noise must not leak into
    // the captured stream `waitForProcessExit`/`readProcessOutput` return to
    // the model. The callback target is deliberately NOT expected to
    // succeed (`https://example.invalid` never resolves) — this step is
    // about what the WRAPPER does to the command's own status/output, not
    // about exercising a real `/api/compute/completion` round trip, which
    // needs a reachable origin this smoke run does not have.
    await assert(
      "4d. a wrapped completion callback preserves the command's exit code and output",
      async () => {
        const marker = `nadi-cb-${rand}`;
        const started = await ctx.backend.startProcess(runtime!, {
          command: `printf '${marker}'; exit 5`,
          timeoutMs: 30_000,
          completionCallback: "curl -sf -m 1 -X POST https://example.invalid/completion",
        });
        let status: { status: string; exitCode?: number } = {
          status: started.status,
          ...(started.exitCode === undefined ? {} : { exitCode: started.exitCode }),
        };
        for (let i = 0; i < 150 && status.status === "running"; i += 1) {
          await sleep(200);
          status = await ctx.backend.getProcessStatus(runtime!, started.process);
        }
        const out = await ctx.backend.readProcessOutput(runtime!, started.process);
        if (status.exitCode !== 5) {
          throw new Error(
            `exitCode=${status.exitCode} expected=5 (the WRAPPER's own status, not the command's, is leaking through)`,
          );
        }
        if ((out.stdout ?? "").trim() !== marker) {
          throw new Error(
            `stdout=${JSON.stringify(out.stdout)} expected exactly ${JSON.stringify(marker)} (callback noise likely leaked in)`,
          );
        }
        return `exitCode=5 preserved; stdout=${JSON.stringify(out.stdout)} (no callback noise); stderr=${JSON.stringify(out.stderr)}`;
      },
    );

    // 5. /workspace exists and is writable (the base image is supposed to ship it).
    await assert("5. /workspace exists and is writable", async () => {
      const probe = `${SMOKE_ROOT}/.writable`;
      const r = await execCollect(
        `mkdir -p ${SMOKE_ROOT} && test -d /workspace && touch ${probe} && [ -w ${probe} ] && printf ok`,
      );
      if (r.stdout.trim() !== "ok") {
        throw new Error(
          `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)} exit=${r.exitCode}`,
        );
      }
      return "/workspace is present and writable";
    });

    // 6. writeFile → readFile, bytes identical (including non-ASCII bytes).
    await assert("6. file round-trip (writeFile → readFile)", async () => {
      const path = `${SMOKE_ROOT}/roundtrip.bin`;
      const src = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 65, 66, 67, 200]);
      await ctx.backend.writeFile(runtime!, path, toArrayBuffer(src), {
        createParents: true,
        overwrite: true,
      });
      const read = await ctx.backend.readFile(runtime!, path, 1_000_000);
      const back = new Uint8Array(read.bytes);
      if (!bytesEqual(src, back)) {
        throw new Error(`bytes differ: wrote ${src.length} read ${back.length}`);
      }
      return `bytes identical (${src.length} bytes)`;
    });

    // 7a. movePath(overwrite:true) must replace an existing destination.
    await assert("7a. movePath(overwrite) replaces existing destination", async () => {
      const from = `${SMOKE_ROOT}/mv-src`;
      const to = `${SMOKE_ROOT}/mv-dst`;
      await ctx.backend.writeFile(runtime!, from, textBuffer("SOURCE"), {
        overwrite: true,
        createParents: true,
      });
      await ctx.backend.writeFile(runtime!, to, textBuffer("DEST-OLD"), {
        overwrite: true,
        createParents: true,
      });
      await ctx.backend.movePath(runtime!, from, to, true);
      const after = bufferText((await ctx.backend.readFile(runtime!, to, 1000)).bytes);
      if (after !== "SOURCE") throw new Error(`destination content=${JSON.stringify(after)}`);
      return "destination replaced with source content";
    });
    // 7b. The never-known fact: raw SDK moveFile onto an existing destination.
    await observe(
      "7b. RAW moveFile onto existing dest (SDK behavior — record verbatim)",
      async () => {
        const from = `${SMOKE_ROOT}/raw-src`;
        const to = `${SMOKE_ROOT}/raw-dst`;
        await ctx.directSandbox.writeFile(from, textBuffer("RAW-SRC"));
        await ctx.directSandbox.writeFile(to, textBuffer("RAW-DST-OLD"));
        let result: { success: boolean } | null = null;
        let threw: string | null = null;
        try {
          result = await ctx.directSandbox.moveFile(from, to);
        } catch (error) {
          threw = message(error);
        }
        let destAfter = "<unreadable>";
        try {
          destAfter = bufferText((await ctx.directSandbox.readFile(to)).bytes);
        } catch {
          destAfter = "<gone/error>";
        }
        if (threw) return `moveFile THREW: ${threw}; dest content now=${JSON.stringify(destAfter)}`;
        return `moveFile RESOLVED success=${result?.success}; dest content now=${JSON.stringify(destAfter)} (replaced=${destAfter === "RAW-SRC"})`;
      },
    );

    // 8. In-band {success:false} vs throw, for each op, plus a success sanity check.
    await observe("8a. raw deleteFile(missing path)", () =>
      describeRaw(() => ctx.directSandbox.deleteFile(`${SMOKE_ROOT}/missing-${rand}`)),
    );
    await observe("8b. raw mkdir(existing /workspace)", () =>
      describeRaw(() => ctx.directSandbox.mkdir("/workspace", true)),
    );
    await observe("8c. raw writeFile(unwritable path: parent is a file)", () =>
      describeRaw(async () => {
        const filePath = `${SMOKE_ROOT}/afile-${rand}`;
        await ctx.directSandbox.writeFile(filePath, textBuffer("x"));
        return ctx.directSandbox.writeFile(`${filePath}/child`, textBuffer("y"));
      }),
    );
    await observe("8d. raw restoreBackup(bogus handle)", () =>
      describeRaw(() =>
        ctx.directSandbox.restoreBackup({ id: `bogus-${rand}`, dir: "/workspace" }),
      ),
    );
    await assert("8e. a successful writeFile is NOT misread as a failure", async () => {
      await ctx.backend.writeFile(runtime!, `${SMOKE_ROOT}/ok.txt`, textBuffer("ok"), {
        overwrite: true,
        createParents: true,
      });
      return "backend.writeFile of a valid path resolved (no false-failure misread)";
    });

    // 8f. THE CONTRACT `pathExists` STANDS ON, and the one no fake can settle:
    // does the real container report `{success:true, exists:false}` for a path
    // that simply is not there, or does it report `{success:false}`?
    // `pathExists` rejects `success:false` outright (an unanswered probe must
    // never read as "proven absent"), and `movePath`/`writeFile(overwrite:false)`
    // run the same probe — including `commit()`'s temp-sibling write. So if
    // absence comes back as `success:false` here, EVERY apply_patch write on
    // Cloudflare fails. Only `FakeCloudflareSandbox` — which this branch wrote
    // itself — currently pins the answer. Probe one PRESENT and one ABSENT path
    // and report both verbatim either way.
    await assert("8f. raw exists() reports success:true for present AND absent", async () => {
      const present = `${SMOKE_ROOT}/exists-present-${rand}`;
      const absent = `${SMOKE_ROOT}/exists-absent-${rand}`;
      await ctx.directSandbox.writeFile(present, textBuffer("x"));
      const describe = async (
        path: string,
      ): Promise<{ text: string; echoed?: string | undefined }> => {
        try {
          const r = await ctx.directSandbox.exists(path);
          return {
            text: `{success:${r.success}, exists:${r.exists}, path:${JSON.stringify(r.path)}}`,
            echoed: r.path,
          };
        } catch (error) {
          return { text: `THREW: ${message(error)}` };
        }
      };
      const presentResult = await describe(present);
      const absentResult = await describe(absent);
      const detail = `present=${presentResult.text} absent=${absentResult.text}`;
      if (
        !presentResult.text.startsWith("{success:true") ||
        !absentResult.text.startsWith("{success:true")
      ) {
        throw new Error(
          `exists() did NOT report success:true for both — pathExists rejects success:false, so this BREAKS every apply_patch write on Cloudflare. ${detail}`,
        );
      }
      // The OTHER half of the contract, and the half only a real container can
      // settle: `existsProbe` throws on any echo mismatch, and that throw now
      // sits on `pathExists`, `writeFile(overwrite:false)` AND `movePath` — so a
      // container that echoes a normalized or relative path breaks every write.
      // Compare exactly as the backend does (trailing slash stripped, nothing else).
      for (const [label, asked, got] of [
        ["present", present, presentResult.echoed],
        ["absent", absent, absentResult.echoed],
      ] as const) {
        if (stripTrailingSlash(got ?? "") !== stripTrailingSlash(asked)) {
          throw new Error(
            `exists() echoed a path that does not match the one asked for (${label}): asked ${JSON.stringify(asked)}, got ${JSON.stringify(got)} — existsProbe throws cloudflare_exists_path_mismatch on this, which BREAKS every apply_patch write on Cloudflare. ${detail}`,
          );
        }
      }
      return `${detail} (absence is answered in band as success:true/exists:false, and both echoes match the path asked for, as pathExists requires)`;
    });

    // 9. inspectPath: file, directory, missing (null, not throw), symlink (type fact).
    await assert("9a. inspectPath(file) → file", async () => {
      const p = `${SMOKE_ROOT}/ip-file`;
      await ctx.backend.writeFile(runtime!, p, textBuffer("x"), {
        overwrite: true,
        createParents: true,
      });
      const info = await ctx.backend.inspectPath(runtime!, p);
      if (info?.type !== "file") throw new Error(`type=${info?.type ?? "null"}`);
      return `type=file size=${info.size}`;
    });
    await assert("9b. inspectPath(directory) → directory", async () => {
      const info = await ctx.backend.inspectPath(runtime!, SMOKE_ROOT);
      if (info?.type !== "directory") throw new Error(`type=${info?.type ?? "null"}`);
      return "type=directory";
    });
    await assert("9c. inspectPath(missing) → null (not throw)", async () => {
      const info = await ctx.backend.inspectPath(runtime!, `${SMOKE_ROOT}/missing-${rand}`);
      if (info !== null) throw new Error(`expected null, got ${JSON.stringify(info)}`);
      return "returned null (did not throw)";
    });
    await observe("9d. inspectPath(symlink) → FileInfo.type (record verbatim)", async () => {
      const link = `${SMOKE_ROOT}/ip-link`;
      await execCollect(`ln -sfn /etc ${link}`);
      const info = await ctx.backend.inspectPath(runtime!, link);
      const type = info?.type ?? "null";
      return `FileInfo.type=${type} (Cloudflare may report "symlink"; Daytona follows the link and never does)`;
    });

    // 10. Recoverable release → restore round-trip, with CURRENT spec.env reapplied.
    await assert("10. recoverable release → restore round-trip", async () => {
      const content = `sentinel-${rand}`;
      await ctx.backend.writeFile(runtime!, SENTINEL_PATH, textBuffer(content), {
        overwrite: true,
        createParents: true,
      });
      const recovery = await ctx.backend.release(runtime!, {
        disposition: "recoverable",
        recoveryTtlMs: 60 * 60 * 1000,
      });
      runtime = null;
      if (!recovery) throw new Error("recoverable release returned null");
      // Resolving the id after release yields a fresh empty container (prod
      // divergence): the sentinel must be absent there → "gone".
      const goneProbe = (await ctx.directSandbox.exists(SENTINEL_PATH)).exists;
      // Re-acquire with a DIFFERENT env so we can prove the CURRENT spec.env wins.
      const spec2: ComputeSpec = { ...ctx.spec, env: { [ENV_SENTINEL]: "phase-2" } };
      runtime = await ctx.backend.acquire(spec2, recovery);
      const restored = bufferText((await ctx.backend.readFile(runtime, SENTINEL_PATH, 1000)).bytes);
      if (restored !== content) {
        throw new Error(`sentinel not restored: read=${JSON.stringify(restored)}`);
      }
      // Trim: the container server appends a trailing newline to captured stdout
      // even though `printf '%s'` emits none (same live fact as step 4a).
      const envCheck = await execCollect(`printf '%s' "$${ENV_SENTINEL}"`);
      if (envCheck.stdout.trim() !== "phase-2") {
        throw new Error(
          `current spec.env not reapplied: ${ENV_SENTINEL}=${JSON.stringify(envCheck.stdout)}`,
        );
      }
      return `sentinel survived byte-for-byte; current spec.env reapplied (${ENV_SENTINEL}=phase-2); container-gone-before-restore=${goneProbe}`;
    });

    // 11. Discard divergence: reuse the stale reference and record which behavior.
    await observe("11. discard → reuse stale reference (divergence, record verbatim)", async () => {
      const stale = runtime;
      if (!stale) throw new Error("no runtime to discard");
      await ctx.backend.release(stale, { disposition: "discard" });
      runtime = null;
      try {
        const info = await ctx.backend.inspectPath(stale, SENTINEL_PATH);
        runtime = stale; // keep for cleanup — a fresh empty container now exists
        return `reuse did NOT throw; inspectPath→${info === null ? "null" : JSON.stringify(info)} ⇒ FRESH EMPTY CONTAINER (reportsMissingRuntimeAfterDiscard=false)`;
      } catch (error) {
        return `reuse THREW code=${errorCode(error) ?? "?"} (${message(error)}) ⇒ reports runtime missing (reportsMissingRuntimeAfterDiscard=true)`;
      }
    });
  } finally {
    // 12. Self-clean: MANDATORY. Destroy the container the run created. The SDK
    // exposes no way to enumerate containers, so cleanup is by-id best-effort;
    // any destroy error is surfaced as a failed step (a possible leak).
    const step = "12. self-clean (destroy created containers)";
    const errors: string[] = [];
    if (runtime) {
      try {
        await ctx.backend.destroy(runtime);
      } catch (error) {
        errors.push(`backend.destroy: ${message(error)}`);
      }
    }
    try {
      await ctx.directSandbox.destroy();
    } catch (error) {
      errors.push(`directSandbox.destroy: ${message(error)}`);
    }
    if (errors.length === 0) {
      push(
        step,
        true,
        "destroyed the run's sandbox by id (SDK cannot enumerate; by-id best-effort)",
      );
    } else {
      push(step, false, `POSSIBLE LEAKED CONTAINER — ${errors.join("; ")}`);
    }
  }

  return { steps };
}

/** Record whether a raw SDK op threw or resolved `{success:...}`, verbatim. */
async function describeRaw(fn: () => Promise<{ success: boolean }>): Promise<string> {
  try {
    const result = await fn();
    return `IN-BAND: resolved {success:${result.success}} (did NOT throw)`;
  } catch (error) {
    return `THREW: ${message(error)}`;
  }
}

function referenceSandboxId(reference: BackendReference): string {
  const payload = reference.payload as { sandboxId?: unknown };
  return typeof payload?.sandboxId === "string" ? payload.sandboxId : "<none>";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function textBuffer(value: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(value));
}

function bufferText(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
