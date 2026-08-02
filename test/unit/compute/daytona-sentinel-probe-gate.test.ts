import { describe, expect, it, vi } from "vitest";
import {
  DaytonaComputeBackend,
  EXIT_SENTINEL_GRACE_MS,
  EXIT_SENTINEL_PROBE_INTERVAL_MS,
  exitSentinelPath,
} from "../../../src/compute/backends/daytona";
import type { BackendProcessReference, BackendReference } from "../../../src/compute/backend";

const SANDBOX_ID = "sbx-sentinel";
const SESSION_ID = "nadi-session";

const runtime: BackendReference = {
  provider: "daytona",
  version: 1,
  payload: { kind: "runtime", sandboxId: SANDBOX_ID },
};

const process: BackendProcessReference = {
  provider: "daytona",
  version: 1,
  payload: { kind: "process", sandboxId: SANDBOX_ID, sessionId: SESSION_ID, commandId: "cmd" },
};

/**
 * A Daytona whose `getSessionCommand` reports whatever `exitCode` is set to, and
 * whose sentinel file may or may not exist. `downloadFile` is a spy: the point
 * of the gate is that it is NOT called for ordinary commands.
 */
function makeBackend(options: { exitCode?: number; sentinel?: string } = {}) {
  const downloadFile = vi.fn(async (path: string) => {
    if (path !== exitSentinelPath(SESSION_ID) || options.sentinel === undefined) {
      throw new Error("not found");
    }
    return new TextEncoder().encode(options.sentinel).buffer as ArrayBuffer;
  });
  const sandbox = {
    id: SANDBOX_ID,
    process: {
      createSession: async () => {},
      executeSessionCommand: async () => ({ cmdId: "cmd" }),
      // Built conditionally, not as `{ exitCode: options.exitCode }`: under
      // exactOptionalPropertyTypes an explicit `undefined` does not satisfy
      // `exitCode?: number` (see nadi-exact-optional-property-types).
      getSessionCommand: async () =>
        options.exitCode === undefined ? {} : { exitCode: options.exitCode },
      getSessionCommandLogs: async () => ({ stdout: "", stderr: "" }),
    },
    fs: { downloadFile },
  };
  const client = { create: async () => ({ id: SANDBOX_ID }), get: async () => sandbox };
  return { backend: new DaytonaComputeBackend({ apiKey: "test", client }), downloadFile };
}

describe("exit sentinel probe gate", () => {
  /**
   * REGRESSION GUARD (#87). The probe is an extra HTTP round-trip on a 500ms
   * poll loop. #85 ran it from the first silent poll, taxing every command:
   * warm `echo` went from a 2.6-3.0s baseline to 6.5-25s in production. The
   * sentinel only ever rescues commands wedged by an orphan holding the pipe,
   * which lasts minutes — so it must not be probed until Daytona's silence has
   * lasted long enough to look like that case.
   */
  it("does not touch the sentinel during the grace window", async () => {
    const { backend, downloadFile } = makeBackend();
    vi.setSystemTime(new Date(0));

    for (let elapsed = 0; elapsed < EXIT_SENTINEL_GRACE_MS; elapsed += 500) {
      vi.setSystemTime(new Date(elapsed));
      expect(await backend.getProcessStatus(runtime, process)).toEqual({ status: "running" });
    }
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("probes once the grace window has passed, and reports the sentinel's code", async () => {
    const { backend, downloadFile } = makeBackend({ sentinel: "7" });
    vi.setSystemTime(new Date(0));
    await backend.getProcessStatus(runtime, process);

    vi.setSystemTime(new Date(EXIT_SENTINEL_GRACE_MS + 1));
    expect(await backend.getProcessStatus(runtime, process)).toEqual({
      status: "exited",
      exitCode: 7,
    });
    expect(downloadFile).toHaveBeenCalledOnce();
  });

  it("throttles repeat probes after the grace window", async () => {
    const { backend, downloadFile } = makeBackend();
    vi.setSystemTime(new Date(0));
    await backend.getProcessStatus(runtime, process);

    vi.setSystemTime(new Date(EXIT_SENTINEL_GRACE_MS + 1));
    await backend.getProcessStatus(runtime, process);
    expect(downloadFile).toHaveBeenCalledOnce();

    // Inside the throttle: no second call.
    vi.setSystemTime(new Date(EXIT_SENTINEL_GRACE_MS + EXIT_SENTINEL_PROBE_INTERVAL_MS - 1));
    await backend.getProcessStatus(runtime, process);
    expect(downloadFile).toHaveBeenCalledOnce();

    // Past it: one more.
    vi.setSystemTime(new Date(EXIT_SENTINEL_GRACE_MS + EXIT_SENTINEL_PROBE_INTERVAL_MS + 2));
    await backend.getProcessStatus(runtime, process);
    expect(downloadFile).toHaveBeenCalledTimes(2);
  });

  // Daytona's own answer stays the fast path and must never pay for a probe.
  it("never probes when Daytona reports an exit code", async () => {
    const { backend, downloadFile } = makeBackend({ exitCode: 3, sentinel: "9" });
    vi.setSystemTime(new Date(0));
    expect(await backend.getProcessStatus(runtime, process)).toEqual({
      status: "exited",
      exitCode: 3,
    });

    vi.setSystemTime(new Date(EXIT_SENTINEL_GRACE_MS * 5));
    expect(await backend.getProcessStatus(runtime, process)).toEqual({
      status: "exited",
      exitCode: 3,
    });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  // An unreadable or absent sentinel means "no answer", never a fabricated exit.
  it("stays running when the sentinel cannot be read", async () => {
    const { backend } = makeBackend();
    vi.setSystemTime(new Date(0));
    await backend.getProcessStatus(runtime, process);
    vi.setSystemTime(new Date(EXIT_SENTINEL_GRACE_MS + 1));
    expect(await backend.getProcessStatus(runtime, process)).toEqual({ status: "running" });
  });

  it("treats a malformed sentinel as no answer rather than NaN", async () => {
    const { backend } = makeBackend({ sentinel: "not-a-number" });
    vi.setSystemTime(new Date(0));
    await backend.getProcessStatus(runtime, process);
    vi.setSystemTime(new Date(EXIT_SENTINEL_GRACE_MS + 1));
    expect(await backend.getProcessStatus(runtime, process)).toEqual({ status: "running" });
  });
});
