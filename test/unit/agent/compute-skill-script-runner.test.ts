import { describe, expect, it } from "vitest";
import { ComputeSkillScriptRunner } from "../../../src/agent/skills/compute-skill-script-runner";
import type { SkillScriptCompute } from "../../../src/agent/skills/compute-skill-script-runner";
import type { SkillScriptRequest } from "agents/skills";

function makeRequest(overrides: Partial<SkillScriptRequest> = {}): SkillScriptRequest {
  return {
    skill: { name: "greet", description: "d", body: "b" },
    path: "scripts/run.py",
    source: "print('hi')",
    input: { who: "world" },
    resources: [],
    ...overrides,
  };
}

// Programmable fake: records uploads, runs the command to completion, and serves
// output.json / output.files back. `execRun` is one blocking call by design —
// there is no status to poll, which is exactly the property that keeps the runner
// off the Cloudflare getProcess-at-exit wedge.
function makeSandbox(opts: {
  exitCode: number;
  files?: Record<string, string>; // path -> content, for execDownloadFile
  stderr?: string;
  runError?: Error;
}): {
  sandbox: SkillScriptCompute;
  uploads: Record<string, string>;
  commands: string[];
  runCalls: () => number;
} {
  const uploads: Record<string, string> = {};
  const commands: string[] = [];
  const files = opts.files ?? {};
  let runCalls = 0;
  const sandbox: SkillScriptCompute = {
    async execRun(input) {
      runCalls++;
      commands.push(input.command);
      if (opts.runError) throw opts.runError;
      return {
        processId: "proc_1",
        status: opts.exitCode === 0 ? "exited" : "failed",
        exitCode: opts.exitCode,
        stdout: "",
        stderr: opts.stderr ?? "",
      };
    },
    async execUploadFile(input) {
      // Both real backends reject a write to an existing path unless `overwrite`
      // is set (cloudflare_file_already_exists / daytona_file_already_exists), and
      // the service defaults `overwrite` to false. A fake that silently clobbers
      // hides that contract.
      if (!input.overwrite && input.destinationPath in uploads) {
        throw new Error("ComputeError: cloudflare_file_already_exists");
      }
      uploads[input.destinationPath] = new TextDecoder().decode(input.bytes);
      return { ok: true, destinationPath: input.destinationPath };
    },
    async execDownloadFile(input) {
      const content = files[input.path];
      if (content === undefined) throw new Error("sandbox_download_not_found");
      return { bytes: new TextEncoder().encode(content).buffer as ArrayBuffer };
    },
  };
  return { sandbox, uploads, commands, runCalls: () => runCalls };
}

describe("ComputeSkillScriptRunner", () => {
  it("materializes script + input and returns parsed output.json on success", async () => {
    const { sandbox, uploads } = makeSandbox({
      exitCode: 0,
      files: { "output.json": JSON.stringify({ ok: 1 }), "output.files": "result.txt\n" },
    });
    // Route output.json / output.files by suffix regardless of run id.
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: null,
    });
    const result = (await runner.run(makeRequest())) as {
      ok: true;
      output: unknown;
      outputFiles: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ ok: 1 });
    expect(result.outputFiles).toEqual(["result.txt"]);
    // input.json written with the model input.
    const inputPath = Object.keys(uploads).find((p) => p.endsWith("/input.json"))!;
    expect(JSON.parse(uploads[inputPath]!)).toEqual({ who: "world" });
    // script written at skill/scripts/run.py.
    expect(Object.keys(uploads).some((p) => p.endsWith("/skill/scripts/run.py"))).toBe(true);
  });

  it("returns structured error on non-zero exit with stderr tail", async () => {
    const { sandbox } = makeSandbox({ exitCode: 3, stderr: "boom" });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: null,
    });
    const result = (await runner.run(makeRequest())) as {
      ok: false;
      error: string;
      exitCode?: number;
      stderrTail?: string;
    };
    expect(result).toMatchObject({ ok: false, error: "script_failed", exitCode: 3 });
    expect(result.stderrTail).toContain("boom");
  });

  it("returns unsupported_interpreter before executing", async () => {
    const { sandbox, commands } = makeSandbox({ exitCode: 0 });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: null,
    });
    const result = (await runner.run(makeRequest({ path: "scripts/run.rb" }))) as {
      ok: false;
      error: string;
    };
    expect(result.error).toBe("unsupported_interpreter");
    expect(commands).toEqual([]); // nothing ran
  });

  it("returns sandbox_unavailable when no service", async () => {
    const runner = new ComputeSkillScriptRunner({ getService: async () => null, allowlist: null });
    const result = (await runner.run(makeRequest())) as { ok: false; error: string };
    expect(result.error).toBe("sandbox_unavailable");
  });

  it("getService rejection → sandbox_unavailable (never throws)", async () => {
    const runner = new ComputeSkillScriptRunner({
      getService: async () => {
        throw new Error("daytona down");
      },
      allowlist: null,
    });
    await expect(runner.run(makeRequest())).resolves.toMatchObject({
      ok: false,
      error: "sandbox_unavailable",
    });
  });

  it("shell-metacharacter path → script_failed before executing", async () => {
    const { sandbox, commands } = makeSandbox({ exitCode: 0 });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: null,
    });
    const result = (await runner.run(makeRequest({ path: 'scripts/ru"n.py' }))) as {
      ok: false;
      error: string;
    };
    expect(result.error).toBe("script_failed");
    expect(commands).toEqual([]);
  });

  it("rejects a declared domain not in the sandbox allowlist", async () => {
    const { sandbox } = makeSandbox({ exitCode: 0 });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: ["allowed.com"],
    });
    const req = makeRequest();
    (req.skill as { metadata?: Record<string, unknown> }).metadata = {
      networkDomains: ["blocked.io"],
    };
    const result = (await runner.run(req)) as { ok: false; error: string; detail?: string };
    expect(result.error).toBe("network_domain_not_allowed");
    expect(result.detail).toContain("blocked.io");
  });
});

import { shouldEnableScriptRunner } from "../../../src/agent/skills/compute-skill-script-runner";

describe("shouldEnableScriptRunner", () => {
  it("requires both sandbox enabled and a script skill", () => {
    expect(shouldEnableScriptRunner(true, true)).toBe(true);
    expect(shouldEnableScriptRunner(false, true)).toBe(false);
    expect(shouldEnableScriptRunner(true, false)).toBe(false);
    expect(shouldEnableScriptRunner(false, false)).toBe(false);
  });
});

// Helper: the fake's execDownloadFile keys by suffix, so wrap it to strip the run-id prefix.
function wrapBySuffix(sandbox: SkillScriptCompute): SkillScriptCompute {
  return {
    ...sandbox,
    async execDownloadFile(input) {
      const suffix = input.path.endsWith("output.json")
        ? "output.json"
        : input.path.endsWith("output.files")
          ? "output.files"
          : input.path;
      return sandbox.execDownloadFile({ ...input, path: suffix });
    },
  };
}

describe("ComputeSkillScriptRunner completion", () => {
  // The whole reason this runner does not start a background process and poll it.
  //
  // On Cloudflare, the getProcess call that coincides with the process exiting
  // wedges the sandbox RPC session for ~10 MINUTES before throwing. Every poll
  // cadence loses: 1000ms races the SDK's 1s idle-disconnect (OPERATION_INTERRUPTED),
  // 2000ms lets the session be torn down and rebuilt across the exit, and even
  // 500ms hung in production. There is no safe interval, so there is no poll:
  // the provider runs the command to completion and reports the exit itself.
  it("runs the script in ONE blocking call — it never polls for the exit", async () => {
    const { sandbox, runCalls } = makeSandbox({
      exitCode: 0,
      files: { "output.json": JSON.stringify({ done: true }), "output.files": "" },
    });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: null,
    });
    const result = (await runner.run(makeRequest())) as { ok: true; output: unknown };
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ done: true });
    // Exactly one call: any retry/poll loop here would reintroduce the wedge.
    expect(runCalls()).toBe(1);
  });

  it("surfaces a nonzero exit with the provider's stderr, without a second call", async () => {
    const { sandbox, runCalls } = makeSandbox({ exitCode: 3, stderr: "Traceback: boom\n" });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: null,
    });
    const result = (await runner.run(makeRequest())) as {
      ok: false;
      error: string;
      exitCode: number;
      stderrTail: string;
    };
    expect(result.error).toBe("script_failed");
    expect(result.exitCode).toBe(3);
    // stderr rides back on the run itself — no follow-up execOutput read, which
    // would be one more chance to touch a wedged session.
    expect(result.stderrTail).toContain("boom");
    expect(runCalls()).toBe(1);
  });

  it("reports a provider failure as script_failed with the detail", async () => {
    const { sandbox } = makeSandbox({
      exitCode: 0,
      runError: new Error("ComputeError: cloudflare_sdk_error: runtime connection closed"),
    });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => wrapBySuffix(sandbox),
      allowlist: null,
    });
    const result = (await runner.run(makeRequest())) as {
      ok: false;
      error: string;
      detail: string;
    };
    expect(result.error).toBe("script_failed");
    expect(result.detail).toContain("cloudflare_sdk_error");
  });
});

describe("ComputeSkillScriptRunner resource/script path collision", () => {
  // The SDK's SkillScriptTool passes `resources: await this.readSkillResources(skill)`,
  // and the script IS one of the skill's resources (it is looked up there by path).
  // So `request.path` reliably appears in `request.resources` — the runner uploaded
  // that path twice, and the second write (overwrite defaulting to false) threw
  // cloudflare_file_already_exists, breaking EVERY run_skill_script call.
  it("runs when the script is also listed in resources (the real SDK shape)", async () => {
    const { sandbox, uploads } = makeSandbox({
      exitCode: 0,
      files: { "/run/output.json": "{}" },
    });
    const runner = new ComputeSkillScriptRunner({
      getService: async () => sandbox,
      allowlist: null,
    });

    const result = await runner.run(
      makeRequest({
        path: "scripts/run.py",
        source: "print('hi')",
        resources: [
          { path: "scripts/run.py", kind: "script", content: "print('hi')" },
          { path: "ref/data.txt", kind: "reference", content: "ref" },
        ] as NonNullable<SkillScriptRequest["resources"]>,
      }),
    );

    expect(result.ok).toBe(true);
    const script = Object.keys(uploads).find((p) => p.endsWith("/skill/scripts/run.py"));
    expect(script).toBeDefined();
    expect(uploads[script as string]).toBe("print('hi')");
  });
});
