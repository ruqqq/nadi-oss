import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";
import { ComputeError, ComputeStaleFileError } from "../../src/compute/errors";
import { openSandboxSession } from "../../src/compute/agent-sandbox-client";

const now = 1_800_000_000_000;

const WORKSPACE_ID = "ws_sbx_session";
const AGENT_ID = "agent_sbx_session";
const DISABLED_WORKSPACE_ID = "ws_sbx_session_off";
const DISABLED_AGENT_ID = "agent_sbx_session_off";

/**
 * See the fixture note in `agent-sandbox-do.integration.test.ts`: seeded from
 * EVERY `it()` (REGISTRY_DB gets its own storage snapshot per test) and every
 * test uses its OWN thread id (a DO addressed by `idFromName` is not proven to
 * get a fresh snapshot per test).
 */
async function seedComputeEnabledThread(threadId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db
    .insert(schema.workspaces)
    .values({ id: WORKSPACE_ID, name: "Sandbox WS", flagsJson: "{}", createdAt: now });
  await db.insert(schema.agents).values({
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: "Nadi",
    systemPrompt: "",
    provider: "anthropic",
    model: "claude-opus-5",
    modelInputModalities: '["text"]',
    reasoningEffort: "medium",
    createdAt: now,
  });
  await db.insert(schema.workspaceSandboxSettings).values({
    workspaceId: WORKSPACE_ID,
    enabled: true,
    provider: "mock",
    providerConfigJson: JSON.stringify({ kind: "mock" }),
    image: "",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.threadIndex).values({
    id: threadId,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    kind: "regular",
    title: "T",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
}

/** The same fixture with the workspace toggle OFF — compute DISABLED, not broken. */
async function seedComputeDisabledThread(threadId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db
    .insert(schema.workspaces)
    .values({ id: DISABLED_WORKSPACE_ID, name: "Off WS", flagsJson: "{}", createdAt: now });
  await db.insert(schema.agents).values({
    id: DISABLED_AGENT_ID,
    workspaceId: DISABLED_WORKSPACE_ID,
    name: "Nadi",
    systemPrompt: "",
    provider: "anthropic",
    model: "claude-opus-5",
    modelInputModalities: '["text"]',
    reasoningEffort: "medium",
    createdAt: now,
  });
  await db.insert(schema.workspaceSandboxSettings).values({
    workspaceId: DISABLED_WORKSPACE_ID,
    enabled: false,
    provider: "mock",
    providerConfigJson: JSON.stringify({ kind: "mock" }),
    image: "",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.threadIndex).values({
    id: threadId,
    workspaceId: DISABLED_WORKSPACE_ID,
    agentId: DISABLED_AGENT_ID,
    kind: "regular",
    title: "T",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
}

function stub(threadId: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(threadId));
}

async function openSession(threadId: string, supportsProcessMonitor = true) {
  const opened = await stub(threadId).session({ threadId, supportsProcessMonitor });
  if (!opened.ok) throw new Error(`session failed: ${opened.error.code}`);
  if (!opened.value) throw new Error("expected compute to be enabled");
  return opened.value;
}

/** Held deliberately across `it()` boundaries — see "the harness cannot..." below. */
let leakedSession: Awaited<ReturnType<typeof openSession>>["session"] | null = null;

describe("AgentSandbox.session", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("serves many calls off ONE resolve, and ships the config beside it", async () => {
    const threadId = "thr_sess_basic";
    await seedComputeEnabledThread(threadId);
    const { session, workspaceId, config } = await openSession(threadId);

    // `workspaceId` and `config` ride along because every consumer of
    // `resolveComputeService` needs them next to the service; a second RPC to
    // fetch them would undo the point of resolving once.
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect(config.provider).toBe("mock");

    expect((await session.execRun({ command: "echo one" })).ok).toBe(true);
    expect((await session.execRun({ command: "echo two" })).ok).toBe(true);
    expect(await session.isComputeLive()).toEqual({ ok: true, value: true });
  });

  it("says compute is DISABLED with a null value, not a failure", async () => {
    const threadId = "thr_sess_disabled";
    await seedComputeDisabledThread(threadId);
    const opened = await stub(threadId).session({ threadId, supportsProcessMonitor: true });
    // `null` is the signal callers must keep treating as "hide every compute
    // tool". Collapsing it into `ok: false` would make a disabled workspace
    // indistinguishable from a broken resolve.
    expect(opened).toEqual({ ok: true, value: null });
  });

  it("ENCODES a failure instead of throwing when the resolve itself breaks", async () => {
    const opened = await stub("thr_sess_missing").session({
      threadId: "thr_sess_missing",
      supportsProcessMonitor: true,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe("session_failed");
  });

  /**
   * The service throws `ComputeError`s the tool surface depends on:
   * `toErrorResult` (`compute-tools.ts:699`) branches on `instanceof
   * ComputeError` to give the model an actionable code. Over RPC the class is
   * gone, so the session encodes it and the client rebuilds it — and the two
   * subclasses carry extra fields the model uses to retarget a retry.
   */
  describe("error fidelity across the boundary", () => {
    it("rebuilds a plain ComputeError with its code", async () => {
      const threadId = "thr_sess_err_code";
      await seedComputeEnabledThread(threadId);
      const resolved = await openSandboxSession(env, threadId, { supportsProcessMonitor: true });
      expect(resolved).not.toBeNull();
      await expect(
        resolved!.service.execWatch({ processId: "proc_does_not_exist" }),
      ).rejects.toMatchObject({ name: "ComputeError", code: "process_missing" });
      await expect(
        resolved!.service.execWatch({ processId: "proc_does_not_exist" }),
      ).rejects.toBeInstanceOf(ComputeError);
    });

    it("rebuilds a ComputeStaleFileError WITH its path and current hash", async () => {
      const threadId = "thr_sess_err_stale";
      await seedComputeEnabledThread(threadId);
      const resolved = await openSandboxSession(env, threadId, { supportsProcessMonitor: true });
      const written = await resolved!.service.files.writeFile({
        path: "note.txt",
        content: "first\n",
      });

      // The subclass fields are the point: a `{code, message}` wire form would
      // reach the model as an anonymous error with nothing to retry against.
      const failure = await resolved!.service.files
        .writeFile({ path: "note.txt", content: "second\n", expectedHash: "deadbeef" })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(ComputeStaleFileError);
      const stale = failure as ComputeStaleFileError;
      expect(stale.code).toBe("compute_stale_file");
      expect(stale.path).toBe("note.txt");
      expect(stale.currentHash).toBe(written.hash);
    });
  });

  /**
   * `service.files` returns a live `ComputeFileService` closing over
   * non-cloneable deps, so it cannot cross the boundary and making it async
   * would not change that. The three methods therefore travel FLAT on the
   * session — one round trip each, and no second stub whose lifetime would need
   * its own answer — and the client regroups them as `.files` locally so
   * `buildComputeFileToolDefs` keeps the shape it already takes.
   */
  it("forwards the file facet flat, and regroups it as .files on the client", async () => {
    const threadId = "thr_sess_files";
    await seedComputeEnabledThread(threadId);

    const { session } = await openSession(threadId);
    const wrote = await session.writeFile({
      path: "a/b.txt",
      content: "hello\n",
      createParents: true,
    });
    expect(wrote.ok).toBe(true);

    const resolved = await openSandboxSession(env, threadId, { supportsProcessMonitor: true });
    const read = await resolved!.service.files.readFile({ path: "a/b.txt" });
    // `readFile` returns line-numbered content, so match on the line body.
    expect(read.content).toContain("hello");

    const patched = await resolved!.service.files.applyPatch({
      patch: [
        "*** Begin Patch",
        "*** Update File: a/b.txt",
        "@@",
        "-hello",
        "+goodbye",
        "*** End Patch",
      ].join("\n"),
      expectedHashes: { "a/b.txt": read.hash },
    });
    expect(patched.written).toBe(1);
    expect((await resolved!.service.files.readFile({ path: "a/b.txt" })).content).toContain(
      "goodbye",
    );
  });

  /**
   * Both flags are CALLER-supplied and silent when wrong (see the DO suite's
   * notes). They must survive the trip through `session()` opts too — a session
   * that quietly resolved with defaults would turn background work on or off
   * with every test still green.
   */
  describe("the session opts reach the resolved service", () => {
    it("REFUSES the process monitor when the session was opened with false", async () => {
      const threadId = "thr_sess_monitor_off";
      await seedComputeEnabledThread(threadId);
      const { session } = await openSession(threadId, false);
      const result = await session.execWatch({ processId: "proc_does_not_exist" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Not a `ComputeError`: `thread-service.ts` throws a plain `Error` here,
      // so it crosses as the synthetic `sandbox_call_failed` code with the
      // message intact — which is what `toErrorResult` shows the model anyway.
      expect(result.error.code).toBe("sandbox_call_failed");
      expect(result.error.message).toContain("compute_process_monitor_unavailable");
    });

    it("ADMITS the process monitor when the session was opened with true", async () => {
      const threadId = "thr_sess_monitor_on";
      await seedComputeEnabledThread(threadId);
      const { session } = await openSession(threadId, true);
      const result = await session.execWatch({ processId: "proc_does_not_exist" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("process_missing");
    });

    it("DERIVES backgroundLongRunningExec from the same flag", async () => {
      // Behaviour, not the flag's value: `backgroundLongRunningExec: false`
      // routes `exec` to the blocking `runCommand` path
      // (`thread-service.ts:643`), `true` to `startProcess`. The default
      // `resolveComputeService` would apply is `!attachedRuntime` = true, so
      // the `false` case is the one that would silently flip.
      const threadId = "thr_sess_bglre_off";
      await seedComputeEnabledThread(threadId);
      const provider = new FakeComputeBackend();
      let clock = now;
      setComputeHostTestOverrides(threadId, {
        buildBackend: async () => provider,
        now: () => clock,
        execForegroundTimeoutMs: 1,
        execForegroundPollIntervalMs: 1,
        sleep: async (ms: number) => {
          clock += ms;
        },
      });
      try {
        const { session } = await openSession(threadId, false);
        const result = await session.exec({ command: "sleep 300", label: "build" });
        expect(result.ok).toBe(true);
        expect(provider.runCommandCalls.length).toBe(1);
        expect(provider.startProcessCalls.length).toBe(0);
      } finally {
        // Scoped to THIS thread id: `integration-fast` runs `isolate: false`,
        // so an unscoped clear would contaminate other files.
        clearComputeHostTestOverrides(threadId);
      }
    });
  });

  /**
   * STUB LIFETIME. A session stub obtained early in a turn and used later may
   * or may not still be valid, and a dead stub surfaces as an opaque RPC error
   * at the call site rather than where it died. These tests record what is
   * actually true — including which observation the harness CANNOT make.
   */
  describe("stub lifetime", () => {
    it("outlives the DO invocation that CREATED it", async () => {
      // The real far-side boundary, and the one the cutover depends on: the
      // `session()` RPC runs in the sandbox DO's own I/O context, builds the
      // RpcTarget and returns — that invocation is over before the first
      // method call below is made.
      const threadId = "thr_sess_lifetime_far";
      await seedComputeEnabledThread(threadId);
      const { session } = await openSession(threadId);

      const db = drizzle(env.REGISTRY_DB, { schema });
      await db.select().from(schema.threadIndex).all();
      await stub("thr_sess_lifetime_other").getComputeStateView({
        threadId: "thr_sess_lifetime_other",
        supportsProcessMonitor: true,
      });

      expect((await session.execRun({ command: "echo after" })).ok).toBe(true);
      leakedSession = session;
    });

    it("throws an ATTRIBUTABLE error at the call site once disposed", async () => {
      const threadId = "thr_sess_lifetime_disposed";
      await seedComputeEnabledThread(threadId);
      const { session } = await openSession(threadId);
      expect((await session.execRun({ command: "echo alive" })).ok).toBe(true);

      (session as unknown as Disposable)[Symbol.dispose]();

      // Verbatim: `Error: RPC stub used after being disposed.` — it rejects the
      // call that used it, naming the cause, rather than arriving as a phantom
      // rejection. So a cutover that drops a stub fails LOUDLY.
      //
      // Captured with try/catch rather than `rejects.toThrow`: a disposed stub
      // also rejects the pipelined property-access promise, which vitest then
      // reports as an unhandled rejection and fails the whole run over.
      let thrown = "no error";
      try {
        await session.execRun({ command: "echo dead" });
      } catch (error) {
        thrown = (error as Error).message;
      }
      expect(thrown).toBe("RPC stub used after being disposed.");
    });

    /**
     * The negative result, recorded so nobody "proves" cross-invocation
     * lifetime with this harness again. `runInDurableObject` runs its callback
     * in the CALLER's I/O context, not a fresh one — the discriminator is an
     * in-flight promise, which workerd refuses to await from a different
     * context and which resolves fine here. Holding a stub across `it()`
     * boundaries is the same non-boundary.
     *
     * Consequence: whether a stub survives a REAL new invocation of the DO that
     * holds it is UNPROVEN here. The cutover must therefore open the session
     * inside the invocation that uses it and never stash it on an instance
     * field for a later one.
     */
    it("cannot be tested across invocations here: runInDurableObject shares the caller's I/O context", async () => {
      const threadId = "thr_sess_lifetime_held";
      await seedComputeEnabledThread(threadId);
      const holder = stub("thr_sess_lifetime_holder");

      await runInDurableObject(holder, async (instance) => {
        (instance as unknown as { __pending?: unknown }).__pending = stub(
          threadId,
        ).getComputeStateView({ threadId, supportsProcessMonitor: true });
      });

      const verdict = await runInDurableObject(holder, async (instance) => {
        const pending = (instance as unknown as { __pending?: Promise<unknown> }).__pending;
        try {
          await pending;
          return "SAME_CONTEXT";
        } catch {
          return "NEW_CONTEXT";
        }
      });
      expect(verdict).toBe("SAME_CONTEXT");

      // And the stub held across `it()` boundaries above is still callable for
      // exactly the same reason — which is why it proves nothing either.
      expect((await leakedSession!.execRun({ command: "echo later" })).ok).toBe(true);
    });
  });
});
