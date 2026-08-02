import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import type { Env } from "../../../src/env";
import {
  createBaseNativeThreadTools,
  mergeNativeThreadTools,
} from "../../../src/agent/thread-tools";
import { buildComputeToolDefs } from "../../../src/agent/compute-tools";
import type { ThreadComputeService } from "../../../src/compute/thread-service";
import { ComputeError } from "../../../src/compute/errors";
import type { BackendReference } from "../../../src/compute/backend";

// The compute exec surface. `exec_input` (dynamic stdin) was intentionally
// dropped in the compute contract; every other tool remains.
const EXEC_TOOL_NAMES = [
  "exec",
  "exec_output",
  "exec_output_grep",
  "exec_output_read",
  "exec_stop",
  "exec_shutdown",
  "exec_list",
  "exec_upload_file",
  "exec_download_file",
  "confirm_workbench_switch",
];

// Model-native file tools ride the same sandbox tool set as exec: present only
// when compute is enabled, hidden with the rest when it is not.
const FILE_TOOL_NAMES = ["read_file", "write_file", "apply_patch"];
const THREAD_KNOWLEDGE_TOOL_NAMES = [
  "grep_thread",
  "list_threads",
  "read_thread",
  "search_threads",
];

const fakeTool = { description: "", inputSchema: {}, execute: async () => ({}) };

describe("mergeNativeThreadTools", () => {
  const baseTools = { listAttachments: fakeTool, remember: fakeTool } as unknown as ToolSet;
  const sandboxTools = Object.fromEntries(
    [...EXEC_TOOL_NAMES, ...FILE_TOOL_NAMES].map((name) => [name, fakeTool]),
  ) as unknown as ToolSet;

  it("hides all compute exec and file tools when compute execution is disabled", () => {
    const merged = mergeNativeThreadTools({ baseTools, sandboxTools, sandboxEnabled: false });
    expect(Object.keys(merged)).toEqual(["listAttachments", "remember"]);
    for (const name of [...EXEC_TOOL_NAMES, ...FILE_TOOL_NAMES]) {
      expect(merged).not.toHaveProperty(name);
    }
  });

  it("includes every compute exec and file tool when compute execution is enabled", () => {
    const merged = mergeNativeThreadTools({ baseTools, sandboxTools, sandboxEnabled: true });
    expect(Object.keys(merged)).toEqual(
      expect.arrayContaining([
        "listAttachments",
        "remember",
        ...EXEC_TOOL_NAMES,
        ...FILE_TOOL_NAMES,
      ]),
    );
  });
});

describe("createBaseNativeThreadTools automaton tools", () => {
  const base = createBaseNativeThreadTools({ env: {} as Env, threadId: "th_base" }) as Record<
    string,
    { needsApproval?: boolean }
  >;

  it("includes the four Automata management tools", () => {
    expect(base).toHaveProperty("list_automata");
    expect(base).toHaveProperty("get_automaton");
    expect(base).toHaveProperty("create_automaton");
    expect(base).toHaveProperty("update_automaton");
  });

  it("gates the mutations behind approval and leaves reads auto-allow", () => {
    expect(base.create_automaton!.needsApproval).toBe(true);
    expect(base.update_automaton!.needsApproval).toBe(true);
    expect(base.list_automata!.needsApproval ?? false).toBe(false);
    expect(base.get_automaton!.needsApproval ?? false).toBe(false);
  });
});

describe("createBaseNativeThreadTools thread knowledge tools", () => {
  it("includes the four model-native thread knowledge tools as read-only tools", () => {
    const base = createBaseNativeThreadTools({
      env: {} as Env,
      threadId: "th_base",
      resolveThreadKnowledgeScope: async () => ({
        workspaceId: "workspace-base",
        callerThreadId: "th_base",
      }),
    }) as Record<string, { needsApproval?: boolean }>;

    expect(Object.keys(base)).toEqual(expect.arrayContaining(THREAD_KNOWLEDGE_TOOL_NAMES));
    for (const name of THREAD_KNOWLEDGE_TOOL_NAMES) {
      expect(base[name]!.needsApproval).toBeUndefined();
    }
  });
});

describe("buildComputeToolDefs", () => {
  it("exposes the full compute exec tool surface and excludes exec_input", () => {
    const service = {} as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
      {
        // `confirm_workbench_switch` is registered only with its safety
        // preconditions wired, so the FULL surface requires them here.
        workbenchSwitch: {
          hasBlockingWork: async () => false,
          adoptCommittedResourceProfile: async () => {},
        },
      },
    );
    expect(Object.keys(tools).sort()).toEqual([...EXEC_TOOL_NAMES].sort());
    expect(tools).not.toHaveProperty("exec_input");
  });

  it("does not expose watcher tools even when process monitor support is enabled", () => {
    const service = {} as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
      { supportsProcessMonitor: true },
    );
    expect(tools).not.toHaveProperty("exec_watch");
    expect(tools).not.toHaveProperty("exec_unwatch");
    expect(tools).not.toHaveProperty("exec_watch_list");
  });

  it("describes backgrounded exec without watcher when process monitor support is disabled", () => {
    const service = {} as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
    );
    const description = (tools.exec as { description: string }).description;
    expect(description).toContain("backgrounded without a watcher in this runtime");
    expect(description).toContain("Do not busy-poll just to wait");
    expect(description).toContain("report that it is still running/backgrounded and stop");
    expect(description).not.toContain("attempts to attach a watcher automatically");
  });

  it("describes synchronous exec when long-running background work is disabled", () => {
    const service = {} as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
      { backgroundLongRunningExec: false },
    );
    const description = (tools.exec as { description: string }).description;
    expect(description).toContain("runs synchronously");
    expect(description).toContain("does not background long-running commands");
    expect(description).not.toContain("backgrounded");
  });

  it("describes synchronous exec when attached to a shared environment", () => {
    const service = {} as unknown as ThreadComputeService;
    const attachedRuntime: BackendReference = {
      provider: "daytona",
      version: 1,
      payload: { kind: "runtime", sandboxId: "sbx_parent" },
    };
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
      { attachedRuntime },
    );
    const description = (tools.exec as { description: string }).description;
    expect(description).toContain("attached subagent runtime runs exec synchronously");
    expect(description).toContain("does not background long-running commands");
    expect(description).toContain("Omit timeoutMs unless intentionally capping runtime");
    expect(description).not.toContain("exec_start");
    expect(description).not.toContain("backgrounded without a watcher");
  });

  it("delegates exec to the resolved service", async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true, processId: "proc_1", status: "exited" });
    const service = { exec } as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
    );
    const result = await (tools.exec as { execute: (i: unknown) => Promise<unknown> }).execute({
      command: "echo hi",
    });
    expect(exec).toHaveBeenCalledWith({ command: "echo hi" });
    expect(result).toEqual({ ok: true, processId: "proc_1", status: "exited" });
    expect(tools).not.toHaveProperty("exec_watch");
  });

  it("delegates exec_shutdown (with confirm) to the resolved service", async () => {
    const execShutdown = vi
      .fn()
      .mockResolvedValue({ ok: true, terminated: true, stoppedProcesses: 0 });
    const service = { execShutdown } as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
    );
    const result = await (
      tools.exec_shutdown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ confirm: true });
    expect(execShutdown).toHaveBeenCalledWith({ confirm: true });
    expect(result).toEqual({ ok: true, terminated: true, stoppedProcesses: 0 });
  });

  it("returns a structured error instead of throwing when the service fails", async () => {
    const service = {
      listActiveWatchersView: vi.fn().mockReturnValue([]),
      execOutput: vi.fn().mockRejectedValue(new Error("sandbox_process_not_found")),
    } as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
    );
    const result = await (
      tools.exec_output as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ processId: "missing" });
    expect(result).toEqual({ ok: false, error: "sandbox_process_not_found" });
  });

  it("returns a ComputeError's code and detail instead of throwing", async () => {
    const service = {
      exec: vi.fn().mockRejectedValue(new ComputeError("quota_exhausted", "disk limit exceeded")),
    } as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
    );
    const result = await (tools.exec as { execute: (i: unknown) => Promise<unknown> }).execute({
      command: "echo hi",
    });
    expect(result).toEqual({
      ok: false,
      error: "quota_exhausted",
      detail: "disk limit exceeded",
    });
  });

  it("notes the network allowlist in exec's description when restricted", () => {
    const service = {} as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
      { networkDomainAllowlist: ["a.com", "b.com"], supportsProcessMonitor: true },
    );
    const description = (tools.exec as { description: string }).description;
    expect(description).toContain("restricted");
    expect(description).toContain("a.com");
    expect(description).toContain("b.com");
    expect(description).toContain("attempts to attach a watcher automatically");
    expect(description).toContain("returned result indicates whether watching was attached");
    expect(description).toContain("When watching is true and no independent work remains");
    expect(description).toContain("end your turn instead of polling");
    expect(description).not.toContain("backgrounded and watched automatically");
  });

  it("omits the network restriction line from exec's description when unrestricted", () => {
    const service = {} as unknown as ThreadComputeService;
    const tools = buildComputeToolDefs(
      async () => service,
      async () => ({ env: {} as never, threadId: "t", workspaceId: "w" }),
      { networkDomainAllowlist: null },
    );
    const description = (tools.exec as { description: string }).description;
    expect(description).not.toContain("restricted");
  });
});
