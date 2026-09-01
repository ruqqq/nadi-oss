import { describe, expect, it } from "vitest";
import type { ComputeSpec } from "../../../src/compute/backend";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import {
  PREPARED_GATE_MARKER,
  PREPARED_SENTINEL_NAME,
} from "../../../src/compute/workspace-layout";

const SPEC: ComputeSpec = {
  environmentId: "fake-gate-test",
  profile: "small",
  workspaceRoot: "/workspace",
  env: {},
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

/** A command shaped like repository preparation's gate probe. */
const GATE = `sh -lc ': ${PREPARED_GATE_MARKER}; test "$(cat '/workspace/threads/thr_x/${PREPARED_SENTINEL_NAME}' 2>/dev/null)" = abc'`;

/**
 * This fake answers every command 0, and repository preparation's gate reads 0
 * as "already prepared" — so its DEFAULT decides whether a preparation test
 * exercises anything or silently becomes a no-op that still passes its summary
 * assertion. That is the defect class the whole seam exists for, so the default
 * is pinned here rather than left to each test to remember.
 */
describe("FakeComputeBackend: the preparation gate cannot be answered by accident", () => {
  it("answers the gate probe 'not prepared' by default", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);

    const started = await backend.startProcess(runtime, { command: GATE, timeoutMs: 1_000 });
    expect(started.exitCode).toBe(1);
    const ran = await backend.runCommand(runtime, { command: GATE, timeoutMs: 1_000 });
    expect(ran.exitCode).toBe(1);
    // Every other command is unaffected.
    expect(
      (await backend.runCommand(runtime, { command: "true", timeoutMs: 1_000 })).exitCode,
    ).toBe(0);
  });

  it("lets a test state 'prepared' out loud, and only that way", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    backend.scriptedExits.push({ match: PREPARED_GATE_MARKER, exitCode: 0 });

    expect((await backend.runCommand(runtime, { command: GATE, timeoutMs: 1_000 })).exitCode).toBe(
      0,
    );
  });

  /**
   * `nextProcessResult` is positional and single-shot. A stub aimed at some
   * later command must not be spent on — or answer — the gate, or a test would
   * silently exercise "already prepared" while believing it had stubbed
   * something else entirely.
   */
  it("does not let a positional stub answer or be consumed by the gate", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    backend.setNextProcessResult({ status: "exited", exitCode: 0, stdout: "for the next one" });

    expect((await backend.runCommand(runtime, { command: GATE, timeoutMs: 1_000 })).exitCode).toBe(
      1,
    );
    // Still there for the command it was written for.
    const next = await backend.runCommand(runtime, { command: "whoami", timeoutMs: 1_000 });
    expect(next.stdout).toBe("for the next one");
  });

  // BOTH entry points: `exec` reaches the gate through `startProcess`, and a
  // guard applied to only one of them is a partial regression no single-path
  // assertion can see.
  it("does not let a positional stub answer or be consumed by the gate (startProcess)", async () => {
    const backend = new FakeComputeBackend();
    const runtime = await backend.acquire(SPEC);
    backend.setNextProcessResult({ status: "exited", exitCode: 0, stdout: "for the next one" });

    expect(
      (await backend.startProcess(runtime, { command: GATE, timeoutMs: 1_000 })).exitCode,
    ).toBe(1);
    const next = await backend.startProcess(runtime, { command: "whoami", timeoutMs: 1_000 });
    expect(next.stdout).toBe("for the next one");
  });
});
