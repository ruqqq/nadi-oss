import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitSentinelPath, withExitSentinel } from "../../../src/compute/backends/daytona";

/**
 * Build the script the backend would send, with the sentinel redirected into a
 * temp dir so the test can read it.
 *
 * Per `nadi-live-shell-test-eval-template`, a test over a generated shell string
 * must EVALUATE it. Regexing the TypeScript source feeds bash `${...}` and
 * fabricates bugs that do not exist — and would pass while the emitted script
 * was broken.
 */
function scriptFor(command: string, sessionId: string) {
  const dir = mkdtempSync(join(tmpdir(), "nadi-sentinel-"));
  const rcPath = join(dir, `rc-${sessionId}`);
  return {
    rcPath,
    script: withExitSentinel(command, sessionId).replaceAll(exitSentinelPath(sessionId), rcPath),
  };
}

function readSentinel(rcPath: string): string | undefined {
  return existsSync(rcPath) ? readFileSync(rcPath, "utf8") : undefined;
}

/**
 * Run to completion. `spawnSync`, not `execFileSync`, because a non-zero exit
 * must be an observation rather than a thrown error — recording non-zero codes
 * is precisely what is under test.
 */
function runWrapped(command: string, sessionId: string) {
  const { script, rcPath } = scriptFor(command, sessionId);
  const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  return {
    stdout: result.stdout,
    sentinel: readSentinel(rcPath),
    // The SCRIPT's own exit status — what Daytona reports as the command's
    // `exitCode`, and a different thing from what the sentinel file contains.
    // Asserting only the sentinel is what let #85 ship a wrapper that turned
    // every failure into `exitCode: 0`.
    scriptExitCode: result.status,
  };
}

describe("withExitSentinel", () => {
  it("runs the original command and records exit code 0", () => {
    const { stdout, sentinel } = runWrapped("echo hello", "s1");
    expect(stdout).toBe("hello\n");
    expect(sentinel).toBe("0");
  });

  it("records a non-zero exit code", () => {
    expect(runWrapped("false", "s2").sentinel).toBe("1");
    expect(runWrapped("sh -c 'exit 42'", "s3").sentinel).toBe("42");
  });

  /**
   * REGRESSION (#85, caught in production). Daytona reports the exit status of
   * the whole script it was handed — the status of its LAST command. When the
   * wrapper ended on the `printf`, which essentially always succeeds, every
   * failing command came back `exitCode: 0`: a silent failure-as-success, worse
   * than the latency the wrapper exists to fix.
   *
   * This asserts the SCRIPT's status, which is the thing the provider reads.
   * The sentinel assertions above cannot catch it — they were green throughout.
   */
  it("preserves the command's own exit status as the SCRIPT's status", () => {
    expect(runWrapped("true", "e1").scriptExitCode).toBe(0);
    expect(runWrapped("false", "e2").scriptExitCode).toBe(1);
    expect(runWrapped("sh -c 'exit 42'", "e3").scriptExitCode).toBe(42);
    expect(runWrapped("echo out; echo err >&2; sh -c 'exit 7'", "e4").scriptExitCode).toBe(7);
  });

  it("keeps the script's status and the sentinel in agreement", () => {
    for (const [command, id] of [
      ["true", "a1"],
      ["false", "a2"],
      ["sh -c 'exit 9'", "a3"],
      ["sleep 3 & echo bg", "a4"],
    ] as const) {
      const { sentinel, scriptExitCode } = runWrapped(command, id);
      expect(String(scriptExitCode)).toBe(sentinel);
    }
  });

  /**
   * The bug, reproduced locally, and the reason the sentinel exists.
   *
   * `sleep 5 & echo STARTED` finishes its shell instantly, but the orphaned
   * child keeps the stdout pipe open — so a reader waiting on pipe closure (a
   * synchronous spawn here; Daytona's `getSessionCommand().exitCode` in
   * production) does not learn the exit for a further 5 seconds. Measured live
   * against Daytona: sentinel readable at ≤10s where `exitCode` arrived at 62.6s.
   *
   * This asserts BOTH halves, which is what makes it a guard rather than a
   * demo: the sentinel is readable early, and the pipe is provably still open
   * at that moment.
   */
  it("records the exit while an orphaned child still holds the pipe open", async () => {
    const { script, rcPath } = scriptFor("sleep 5 & echo STARTED", "s4");
    const child = spawn("/bin/sh", ["-c", script]);
    // `close` (all stdio EOF), NOT `exit` (process gone). The shell exits
    // immediately either way; what an orphan holds open is the PIPE, and pipe
    // closure is exactly what Daytona waits for before reporting exitCode.
    let pipeClosed = false;
    const closed = new Promise<void>((resolve) =>
      child.on("close", () => {
        pipeClosed = true;
        resolve();
      }),
    );

    const started = Date.now();
    let sentinel: string | undefined;
    while (Date.now() - started < 5_000) {
      sentinel = readSentinel(rcPath);
      if (sentinel !== undefined && sentinel !== "") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const sentinelAt = Date.now() - started;

    expect(sentinel).toBe("0");
    // Well inside the child's 5s lifetime — the improvement this buys.
    expect(sentinelAt).toBeLessThan(2_000);
    // And the pipe really was still open, or the assertion above proves nothing:
    // it is pipe closure that gates Daytona's own answer.
    expect(pipeClosed).toBe(false);

    await closed;
  }, 15_000);

  it("preserves the exit code of a compound command's last element", () => {
    expect(runWrapped("true && false", "s5").sentinel).toBe("1");
    expect(runWrapped("false; true", "s6").sentinel).toBe("0");
  });

  it("keeps a heredoc intact", () => {
    const { stdout, sentinel } = runWrapped("cat <<EOF\nline\nEOF", "s7");
    expect(stdout).toBe("line\n");
    expect(sentinel).toBe("0");
  });

  it("does not leak the sentinel write into the command's own output", () => {
    expect(runWrapped("echo only-this", "s8").stdout).toBe("only-this\n");
  });

  /**
   * REGRESSION GUARD. Daytona runs commands in a PERSISTENT session shell, so a
   * bare `exit N` killed that shell and Daytona then never recorded the
   * command's completion: measured in production at the full 10-minute
   * `maxProcessRuntimeMs`, returning `status: "stopped", exitCode: -1` after
   * 606s. The subshell confines `exit` so the status is reported normally.
   */
  it("contains `exit` inside the subshell instead of killing the shell", () => {
    const { stdout, sentinel, scriptExitCode } = runWrapped("echo bye; exit 3", "s9");
    expect(stdout).toBe("bye\n");
    expect(sentinel).toBe("3");
    expect(scriptExitCode).toBe(3);
  });

  // `exec` now replaces only the subshell, so the parent still reports.
  it("survives a command that execs away", () => {
    const { stdout, sentinel, scriptExitCode } = runWrapped(
      'exec sh -c "echo replaced; exit 5"',
      "s12",
    );
    expect(stdout).toBe("replaced\n");
    expect(sentinel).toBe("5");
    expect(scriptExitCode).toBe(5);
  });

  // A subshell cannot change the SESSION shell's env — which costs nothing,
  // because each exec gets a fresh session and cwd is set by a separate command.
  it("keeps cd and other shell state working inside the command", () => {
    expect(runWrapped("cd /tmp && pwd", "s13").stdout).toBe("/tmp\n");
  });

  // `( )` is a syntax error, so a blank command must pass through unwrapped
  // rather than become a failing one.
  it("leaves a blank command unwrapped", () => {
    expect(withExitSentinel("", "s14")).toBe("");
    expect(withExitSentinel("   ", "s15")).toBe("   ");
  });

  // Appending to a trailing line continuation would splice the sentinel into
  // the user's own command line and change what runs.
  it("refuses to wrap a command ending in a line continuation", () => {
    const command = "echo a \\";
    expect(withExitSentinel(command, "s10")).toBe(command);
    expect(withExitSentinel("echo a \\  ", "s11")).toBe("echo a \\  ");
  });

  it("keys the sentinel path on the session id", () => {
    expect(exitSentinelPath("nadi-abc")).toBe("/tmp/.nadi-rc-nadi-abc");
    expect(exitSentinelPath("a")).not.toBe(exitSentinelPath("b"));
  });
});
