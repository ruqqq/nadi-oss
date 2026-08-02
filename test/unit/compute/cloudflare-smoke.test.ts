import { describe, expect, it } from "vitest";
import type { ComputeSpec } from "../../../src/compute/backend";
import type { ComputeProviderReadiness } from "../../../src/compute/settings";
import type { CloudflareSandbox } from "../../../src/compute/backends/cloudflare-client";
import { runCloudflareComputeSmoke } from "../../../src/compute/backends/cloudflare-smoke";
import { deriveSandboxId } from "../../../src/compute/backends/cloudflare";
import { createFakeCloudflareBackend } from "./helpers/fake-cloudflare-client";

/**
 * These tests prove ONLY the orchestration of the live Cloudflare smoke endpoint
 * — step ordering, that a failing step never aborts the run, and that the
 * self-clean always destroys the created container. The endpoint's SUBJECT
 * MATTER (what a real container actually does) is unverifiable off a deployed
 * Worker: the fake below cannot model a real `printf`, a symlink type, or
 * `/api/move` overwrite semantics, which is exactly why the endpoint exists. No
 * assertion here should be read as verifying live provider behavior.
 */

// Derived, never hardcoded: the id format is `deriveSandboxId`'s business, and
// a literal here would silently diverge from it (as it did when the format was
// bounded to 63 chars).
const SANDBOX_ID = deriveSandboxId("workspace-1", "thread-1");

const READY: ComputeProviderReadiness = {
  provider: "cloudflare",
  ready: true,
  missingConfig: [],
  unsupported: [],
};

const SPEC: ComputeSpec = {
  environmentId: "cloudflare:small",
  profile: "small",
  workspaceRoot: "/workspace",
  env: { NADI_CF_SMOKE: "phase-1" },
  maxProcessRuntimeMs: 60_000,
  allowedHosts: null,
};

/** Leading step number, e.g. "3" from "3. acquire ...". */
function leadingNumber(step: string): number {
  return Number.parseInt(step, 10);
}

describe("runCloudflareComputeSmoke orchestration", () => {
  it("runs every step in order and self-cleans, even though live steps fail against the fake", async () => {
    const { backend, factory, bindings } = createFakeCloudflareBackend();
    const raw = factory.get(bindings.small, SANDBOX_ID, {
      enableDefaultSession: false,
      keepAlive: true,
    });
    let destroyCalls = 0;
    const directSandbox = new Proxy(raw, {
      get(target, prop, _receiver) {
        if (prop === "destroy") {
          return async () => {
            destroyCalls += 1;
            return target.destroy();
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as CloudflareSandbox;

    const { steps } = await runCloudflareComputeSmoke({
      backend,
      directSandbox,
      readiness: READY,
      expectedSandboxId: SANDBOX_ID,
      environmentId: SPEC.environmentId,
      spec: SPEC,
      sleep: async () => {},
    });

    const names = steps.map((s) => s.step);
    // First real step is readiness (1.), last is the mandatory self-clean (12.).
    expect(names[0]).toMatch(/^1\./);
    expect(names.at(-1)).toMatch(/^12\./);
    // Leading step numbers are non-decreasing (ordering preserved).
    const numbers = names.map(leadingNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));

    // The claims a fake CANNOT settle are present as observations.
    expect(names.some((n) => n.includes("fail-closed egress"))).toBe(true);
    expect(names.some((n) => n.includes("RAW moveFile"))).toBe(true);
    expect(names.some((n) => n.includes("symlink"))).toBe(true);
    expect(names.some((n) => n.includes("discard"))).toBe(true);

    // Self-clean ran and reported success.
    expect(destroyCalls).toBeGreaterThanOrEqual(1);
    const cleanup = steps.at(-1)!;
    expect(cleanup.step).toContain("self-clean");
    expect(cleanup.ok).toBe(true);

    // Readiness + fail-closed + acquire hold against the real backend logic.
    expect(steps.find((s) => s.step.startsWith("1."))?.ok).toBe(true);
    expect(steps.find((s) => s.step.startsWith("2."))?.ok).toBe(true);
    expect(steps.find((s) => s.step.startsWith("3."))?.ok).toBe(true);

    // Some live steps genuinely FAIL against the fake (its process model cannot
    // run `printf`) — proving self-clean happens despite failures, not only on a
    // clean run.
    expect(steps.some((s) => !s.ok && s.step !== cleanup.step)).toBe(true);
  });

  // Step 8f exists to settle the `exists()` contract that every Cloudflare write
  // stands on, and `existsProbe` throws on an echo mismatch for all three of its
  // callers — `pathExists`, `writeFile(overwrite:false)` and `movePath`. 8f used
  // to capture the echoed path into its detail string and never compare it, so a
  // container echoing a normalized or relative path would break every write while
  // 8f still reported ok. This is orchestration-level (the fake echoes correctly,
  // so the happy case is real); the mismatch is injected at the SDK seam.
  it("8f fails when the container echoes a path other than the one probed", async () => {
    const runWithExists = async (
      exists: (target: CloudflareSandbox, path: string) => Promise<unknown>,
    ) => {
      const { backend, factory, bindings } = createFakeCloudflareBackend();
      const raw = factory.get(bindings.small, SANDBOX_ID, {
        enableDefaultSession: false,
        keepAlive: true,
      });
      const directSandbox = new Proxy(raw, {
        get(target, prop, _receiver) {
          if (prop === "exists") {
            return async (path: string) => exists(target as unknown as CloudflareSandbox, path);
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as CloudflareSandbox;

      const { steps } = await runCloudflareComputeSmoke({
        backend,
        directSandbox,
        readiness: READY,
        expectedSandboxId: SANDBOX_ID,
        environmentId: SPEC.environmentId,
        spec: SPEC,
        sleep: async () => {},
      });
      return steps.find((s) => s.step.startsWith("8f."))!;
    };

    // Baseline: the fake echoes the path it was asked about, so 8f passes.
    const honest = await runWithExists((target, path) =>
      (target as unknown as { exists(p: string): Promise<unknown> }).exists(path),
    );
    expect(honest.ok).toBe(true);

    // A container that answers about a DIFFERENT path. `success`/`exists` stay
    // healthy-looking, so only the echo comparison can catch it.
    const mixedUp = await runWithExists(async () => ({
      success: true,
      exists: false,
      path: "/somewhere/else",
    }));
    expect(mixedUp.ok).toBe(false);
    expect(mixedUp.detail).toContain("echoed a path that does not match");
  });

  it("records a possible leak when the self-clean destroy fails", async () => {
    const { backend } = createFakeCloudflareBackend();
    // A directSandbox whose every method (including destroy) rejects: observation
    // steps just record probe errors, and the finally destroy must surface a leak.
    const throwing = new Proxy(
      {},
      {
        get() {
          return async () => {
            throw new Error("boom");
          };
        },
      },
    ) as unknown as CloudflareSandbox;

    const { steps } = await runCloudflareComputeSmoke({
      backend,
      directSandbox: throwing,
      readiness: READY,
      expectedSandboxId: SANDBOX_ID,
      environmentId: SPEC.environmentId,
      spec: SPEC,
      sleep: async () => {},
    });

    const cleanup = steps.at(-1)!;
    expect(cleanup.step).toContain("self-clean");
    expect(cleanup.ok).toBe(false);
    expect(cleanup.detail).toContain("POSSIBLE LEAKED CONTAINER");
  });

  it("reports readiness failure as step 1 without acquiring anything", async () => {
    const { backend, factory, bindings } = createFakeCloudflareBackend();
    const directSandbox = factory.get(bindings.small, SANDBOX_ID, {
      enableDefaultSession: false,
      keepAlive: true,
    }) as unknown as CloudflareSandbox;

    const notReady: ComputeProviderReadiness = {
      provider: "cloudflare",
      ready: false,
      missingConfig: ["R2_ACCESS_KEY_ID"],
      unsupported: [],
    };

    const { steps } = await runCloudflareComputeSmoke({
      backend,
      directSandbox,
      readiness: notReady,
      expectedSandboxId: SANDBOX_ID,
      environmentId: SPEC.environmentId,
      spec: SPEC,
      sleep: async () => {},
    });

    const readiness = steps.find((s) => s.step.startsWith("1."))!;
    expect(readiness.ok).toBe(false);
    expect(readiness.detail).toContain("R2_ACCESS_KEY_ID");
    // Self-clean still runs (the container may have been created by later steps).
    expect(steps.at(-1)!.step).toContain("self-clean");
  });
});
