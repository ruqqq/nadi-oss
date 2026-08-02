import { beforeEach, describe, expect, it } from "vitest";
import { buildComputeBackend } from "../../../src/compute/registry";
import { MockComputeBackend, __resetMockComputeState } from "../../../src/compute/backends/mock";
import {
  DEFAULT_COMPUTE_LIMITS,
  defaultProviderConfig,
  providerConfigSchema,
  resolveDefaultSandboxProvider,
} from "../../../src/compute/config";
import type { Env } from "../../../src/env";
import type { ComputeSpec } from "../../../src/compute/backend";
import type { EffectiveComputeConfig } from "../../../src/compute/types";

function mockEffectiveConfig(): EffectiveComputeConfig {
  return {
    provider: "mock",
    providerConfig: { kind: "mock" },
    resourceProfile: "small",
    idleTimeoutMs: 900_000,
    recoveryTtlMs: 86_400_000,
    maxProcessRuntimeMs: 600_000,
    monitorPollIntervalMs: 1_000,
    limits: DEFAULT_COMPUTE_LIMITS,
    allowedHosts: null,
    editableEnv: {},
    agentEditableEnv: {},
    secretEnvNames: [],
    environmentEditableEnv: {},
    environmentSecretEnvNames: [],
  };
}

const SPEC: ComputeSpec = {
  environmentId: "mock:small",
  profile: "small",
  workspaceRoot: "/workspace",
  env: {},
  maxProcessRuntimeMs: 1_000,
  allowedHosts: null,
};

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

beforeEach(() => __resetMockComputeState());

describe("mock provider config", () => {
  it("parses a {kind:'mock'} provider config", () => {
    expect(providerConfigSchema.parse({ kind: "mock" })).toEqual({ kind: "mock" });
  });

  it("defaults the mock provider to an empty mock config", () => {
    expect(defaultProviderConfig("mock")).toEqual({ kind: "mock" });
  });

  it("resolves DEFAULT_SANDBOX_PROVIDER, falling back to cloudflare", () => {
    expect(resolveDefaultSandboxProvider({ DEFAULT_SANDBOX_PROVIDER: "mock" })).toBe("mock");
    expect(resolveDefaultSandboxProvider({ DEFAULT_SANDBOX_PROVIDER: " Daytona " })).toBe(
      "daytona",
    );
    expect(resolveDefaultSandboxProvider({ DEFAULT_SANDBOX_PROVIDER: "" })).toBe("cloudflare");
    expect(resolveDefaultSandboxProvider({})).toBe("cloudflare");
    expect(resolveDefaultSandboxProvider({ DEFAULT_SANDBOX_PROVIDER: "bogus" })).toBe("cloudflare");
  });
});

describe("buildComputeBackend mock dispatch", () => {
  it("builds a mock backend with NO deployment config and never throws", async () => {
    const backend = await buildComputeBackend({} as Env, "ws-x", "thread-y", mockEffectiveConfig());
    expect(backend.id).toBe("mock");
  });
});

describe("MockComputeBackend", () => {
  it("acquires, echoes a command, and reads/writes files in memory", async () => {
    const backend = new MockComputeBackend();
    const runtime = await backend.acquire(SPEC);

    const run = await backend.runCommand!(runtime, {
      command: "echo hello-sandbox",
      timeoutMs: 1_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("hello-sandbox\n");

    await backend.writeFile(runtime, "/workspace/note.txt", encode("hi"), {
      createParents: true,
      overwrite: true,
    });
    expect(await backend.pathExists(runtime, "/workspace/note.txt")).toBe(true);
    const read = await backend.readFile(runtime, "/workspace/note.txt", 1_000);
    expect(decode(read.bytes)).toBe("hi");
    const entries = await backend.listDirectory(runtime, "/workspace");
    expect(entries).toContainEqual({ name: "note.txt", type: "file" });
  });

  it("recovers a suspended sandbox across a fresh backend instance (process-global state)", async () => {
    const first = new MockComputeBackend();
    const runtime = await first.acquire(SPEC);
    await first.writeFile(runtime, "/workspace/keep.txt", encode("data"), {
      createParents: true,
      overwrite: true,
    });
    const recovery = await first.release(runtime, { disposition: "recoverable" });
    expect(recovery).not.toBeNull();

    // A brand-new instance (as `buildComputeBackend` mints each turn) must still
    // recover the same in-memory sandbox from the process-global store.
    const second = new MockComputeBackend();
    const restored = await second.acquire(SPEC, recovery!);
    const read = await second.readFile(restored, "/workspace/keep.txt", 1_000);
    expect(decode(read.bytes)).toBe("data");
  });

  it("degrades a lost recovery reference to a fresh sandbox instead of throwing", async () => {
    const backend = new MockComputeBackend();
    // A recovery ref whose sandbox no longer exists (e.g. after a dev restart).
    const stale = {
      provider: "mock" as const,
      version: 1 as const,
      payload: { kind: "recovery", sandboxId: "mock_gone" },
    };
    const runtime = await backend.acquire(SPEC, stale);
    expect(await backend.pathExists(runtime, "/workspace")).toBe(true);
  });

  it("discard release removes the sandbox", async () => {
    const backend = new MockComputeBackend();
    const runtime = await backend.acquire(SPEC);
    expect(await backend.release(runtime, { disposition: "discard" })).toBeNull();
    await expect(backend.pathExists(runtime, "/workspace")).rejects.toThrow();
  });
});
