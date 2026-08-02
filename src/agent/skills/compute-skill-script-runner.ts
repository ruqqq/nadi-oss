import type { SkillResource, SkillScriptRequest, SkillScriptRunner } from "agents/skills";
import { resolveInterpreter, UnsupportedInterpreterError } from "./interpreter";
import { log } from "../../log";

/** The narrow slice of ThreadComputeService the runner needs. */
export interface SkillScriptCompute {
  execRun(input: {
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    label?: string | undefined;
  }): Promise<{
    processId: string;
    status: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  execUploadFile(input: {
    destinationPath: string;
    bytes: ArrayBuffer;
    overwrite?: boolean;
  }): Promise<unknown>;
  execDownloadFile(input: { path: string; maxBytes: number }): Promise<{ bytes: ArrayBuffer }>;
}

export type SkillScriptResult =
  | { ok: true; exitCode: 0; output: unknown; outputFiles: string[] }
  | { ok: false; error: string; detail?: string; exitCode?: number; stderrTail?: string };

const OUTPUT_MAX_BYTES = 1_000_000;
const STDERR_TAIL_MAX = 4_000;

export class ComputeSkillScriptRunner implements SkillScriptRunner {
  constructor(
    private readonly deps: {
      getService: () => Promise<SkillScriptCompute | null>;
      allowlist: string[] | null;
      threadId?: string;
      now?: () => number;
    },
  ) {}

  async run(request: SkillScriptRequest): Promise<SkillScriptResult> {
    // Observability wrapper: emit exactly one structured event per run with NO
    // script source, input, or output bodies (spec: no secrets/bodies in logs).
    const clock = this.deps.now ?? (() => Date.now());
    const start = clock();
    let result: SkillScriptResult;
    try {
      result = await this._run(request);
    } catch (error) {
      result = { ok: false, error: "script_failed", detail: String(error) };
    }
    log.info("skill_script.run", {
      ...(this.deps.threadId ? { threadId: this.deps.threadId } : {}),
      skillName: request.skill.name,
      language: request.path.split(".").pop() ?? "",
      outcome: result.ok ? "ok" : result.error,
      ...(result.ok || result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      durationMs: clock() - start,
    });
    return result;
  }

  private async _run(request: SkillScriptRequest): Promise<SkillScriptResult> {
    // 1. Interpreter (validate before any compute work).
    let interpreter: "bash" | "python3" | "node";
    try {
      interpreter = resolveInterpreter(request.path).interpreter;
    } catch (error) {
      if (error instanceof UnsupportedInterpreterError) {
        return { ok: false, error: "unsupported_interpreter", detail: request.path };
      }
      return { ok: false, error: "script_failed", detail: String(error) };
    }

    if (!/^[A-Za-z0-9._/-]+$/.test(request.path) || request.path.includes("..")) {
      return { ok: false, error: "script_failed", detail: `invalid script path: ${request.path}` };
    }

    // 2. Declared-domain guard (defense-in-depth; primary enforcement is the
    //    compute allowlist union at creation).
    const declared = readDeclaredDomains(request);
    if (this.deps.allowlist) {
      const missing = declared.filter((d) => !this.deps.allowlist!.includes(d));
      if (missing.length) {
        return {
          ok: false,
          error: "network_domain_not_allowed",
          detail: `${missing.join(", ")} — run exec_shutdown to recreate the sandbox, or add to the agent's sandbox network settings`,
        };
      }
    }

    // 3. Resolve the warm compute environment.
    let service: SkillScriptCompute | null;
    try {
      service = await this.deps.getService();
    } catch (error) {
      return { ok: false, error: "sandbox_unavailable", detail: String(error) };
    }
    if (!service) return { ok: false, error: "sandbox_unavailable" };

    const runId = `skl_${crypto.randomUUID()}`;
    const root = `/run/${runId}`;
    const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

    try {
      // 4. Materialize script + reference resources + input.json.
      //
      // Every upload sets `overwrite` (the service defaults it to false, and both
      // backends throw *_file_already_exists on a write to an existing path). The
      // script is ALSO one of the skill's resources — the SDK looks it up there by
      // path and passes the full resource list — so the loop below rewrites
      // `skill/${request.path}`. Without overwrite that second write threw and every
      // run_skill_script call failed. Clobbering is safe and idempotent here: `root`
      // is a fresh per-run uuid this runner owns, and execUploadFile rejects any
      // ".." segment, so a resource path cannot escape it.
      await service.execUploadFile({
        destinationPath: `${root}/skill/${request.path}`,
        bytes: enc(request.source),
        overwrite: true,
      });
      for (const res of request.resources ?? []) {
        if (res.path === request.path) continue; // already written from `source`
        await service.execUploadFile({
          destinationPath: `${root}/skill/${res.path}`,
          bytes: decodeResource(res),
          overwrite: true,
        });
      }
      await service.execUploadFile({
        destinationPath: `${root}/input.json`,
        bytes: enc(JSON.stringify(request.input ?? null)),
        overwrite: true,
      });

      // 5. Run: mkdir output, run interpreter, capture code, write file manifest, re-exit with code.
      const command =
        `mkdir -p "${root}/output"; ${interpreter} "$SKILL_ENTRY"; code=$?; ` +
        `(cd "${root}/output" && find . -type f 2>/dev/null | sed 's|^\\./||') > "${root}/output.files" 2>/dev/null; exit $code`;
      const env = {
        SKILL_DIR: `${root}/skill`,
        SKILL_INPUT: `${root}/input.json`,
        SKILL_OUTPUT_DIR: `${root}/output`,
        SKILL_OUTPUT_JSON: `${root}/output.json`,
        SKILL_ENTRY: `${root}/skill/${request.path}`,
      };
      // 6. Run it to completion in ONE call and let the provider report the exit.
      //
      // This deliberately does NOT start a background process and poll for its
      // status. That shape — upload, startProcess, then poll getProcess until it
      // exits, all inside one Durable Object invocation — wedged on Cloudflare
      // every single time: one getProcess call blocked ~10 minutes and then
      // threw. No cadence saved it (1000ms raced the SDK's 1s idle-disconnect,
      // 2000ms and 500ms both hung), so we stopped asking for a status: the
      // container already knows when the script finished.
      const run = await service.execRun({
        command,
        cwd: root,
        env,
        label: `skill:${request.skill.name}`,
      });

      if (run.exitCode !== 0) {
        return {
          ok: false,
          error: "script_failed",
          exitCode: run.exitCode,
          stderrTail: run.stderr.slice(-STDERR_TAIL_MAX),
        };
      }

      // 7. Collect output (written by the script into $SKILL_OUTPUT_DIR).
      const output = await this.readJsonBestEffort(service, `${root}/output.json`);
      const outputFiles = await this.readManifestBestEffort(service, `${root}/output.files`);
      return { ok: true, exitCode: 0, output, outputFiles };
    } catch (error) {
      return { ok: false, error: "script_failed", detail: String(error) };
    }
  }

  private async readJsonBestEffort(service: SkillScriptCompute, path: string): Promise<unknown> {
    try {
      const dl = await service.execDownloadFile({ path, maxBytes: OUTPUT_MAX_BYTES });
      return JSON.parse(new TextDecoder().decode(dl.bytes));
    } catch {
      return null;
    }
  }

  private async readManifestBestEffort(
    service: SkillScriptCompute,
    path: string,
  ): Promise<string[]> {
    try {
      const dl = await service.execDownloadFile({ path, maxBytes: OUTPUT_MAX_BYTES });
      return new TextDecoder()
        .decode(dl.bytes)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * Pure gate: `run_skill_script` is enabled only when the thread compute is
 * enabled AND some enabled skill actually has a script. Extracted so the gate
 * logic is unit-testable without compute-secret seeding.
 */
export function shouldEnableScriptRunner(
  computeEnabled: boolean,
  hasScriptSkill: boolean,
): boolean {
  return computeEnabled && hasScriptSkill;
}

function readDeclaredDomains(request: SkillScriptRequest): string[] {
  const meta = (request.skill as { metadata?: Record<string, unknown> }).metadata;
  const raw = meta?.networkDomains;
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : [];
}

function decodeResource(res: SkillResource): ArrayBuffer {
  if (res.encoding === "base64") {
    const bin = atob(res.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  return new TextEncoder().encode(res.content).buffer as ArrayBuffer;
}
