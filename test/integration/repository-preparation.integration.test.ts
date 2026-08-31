import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryPreparation } from "../../src/agent/repository-preparation";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

/**
 * The live gate on the workbench -> agent data migration.
 *
 * Every other check on it is a typecheck or a mocked unit test, and neither can
 * see the failure this migration is most able to cause: `agent_repositories`
 * keyed on one column while every reader keys on another. That returns zero
 * rows, which `createRepositoryPreparation` reports as a summary with NO
 * `skipped` entries — so nothing is cloned, `agent-sandbox-do.ts`'s log.warn
 * never fires, and the only visible symptom is an empty /workspace.
 *
 * So this seeds real D1 rows the way the migration leaves them and asserts the
 * thread actually issues `git clone`. Nothing is mocked below the repository
 * layer except the sandbox's shell.
 */
describe("repository preparation against real D1", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await env.REGISTRY_DB.prepare("DELETE FROM agent_repositories").run();
    await env.REGISTRY_DB.prepare("DELETE FROM thread_index").run();
  });

  /** A sandbox whose checkout path does not exist, so preparation must clone. */
  function missingCheckoutService() {
    const exec = vi.fn(async (input: { command: string }) => {
      if (input.command.includes("mkdir -p /workspace")) {
        return { status: "exited" as const, processId: "root", exitCode: 0 };
      }
      if (input.command.includes("test -e")) {
        // Cloudflare's shape for a missing path: non-zero comes back as
        // `failed`, never `exited`.
        return { status: "failed" as const, processId: "probe", exitCode: 1 };
      }
      return { status: "exited" as const, processId: "cmd", exitCode: 0 };
    });
    return { exec, execOutput: vi.fn() };
  }

  it("clones the repositories its AGENT declares", async () => {
    const threadId = "thr_prep_live";
    const { agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId: "workspace-prep-live",
      runtime: "think",
    });
    // Keyed on `agent_id`, exactly as migration 0067 leaves it. If the reader
    // and this column ever disagree, the assertions below go red rather than
    // the sandbox silently coming up empty.
    await env.REGISTRY_DB.prepare(
      `INSERT INTO agent_repositories
        (id, agent_id, source, name, url, default_branch, checkout_path_name, root_directory, setup_command, package_manager, created_at)
       VALUES (?, ?, 'url', 'nadi', 'https://example.test/nadi.git', 'main', 'nadi', '', '', '', 1)`,
    )
      .bind("agr_prep_live", agentId)
      .run();

    const service = missingCheckoutService();
    const prepareRepositories = createRepositoryPreparation({
      env: env as never,
      threadId,
      resolveComputeService: async () => ({ service: service as never }),
    });

    await expect(prepareRepositories()).resolves.toMatchObject({
      summary: "Repositories are ready for coding work.",
      prepared: [{ name: "nadi", checkoutPath: "/workspace/nadi", status: "cloned" }],
    });
    expect(service.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("git clone"),
      }),
    );
  });

  it("clones NOTHING for a thread whose agent declares no repositories", async () => {
    const threadId = "thr_prep_live_empty";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId: "workspace-prep-live-empty",
      runtime: "think",
    });
    // The row exists, but on a DIFFERENT agent. This is the negative half: it
    // fails if the lookup ever stops being scoped to the thread's own agent.
    await env.REGISTRY_DB.prepare(
      "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("agent-someone-else", "workspace-prep-live-empty", "Other", "p", "mock", "mock", 1)
      .run();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO agent_repositories
        (id, agent_id, source, name, url, default_branch, checkout_path_name, root_directory, setup_command, package_manager, created_at)
       VALUES (?, ?, 'url', 'other', 'https://example.test/other.git', 'main', 'other', '', '', '', 1)`,
    )
      .bind("agr_prep_live_other", "agent-someone-else")
      .run();

    const service = missingCheckoutService();
    const prepareRepositories = createRepositoryPreparation({
      env: env as never,
      threadId,
      resolveComputeService: async () => ({ service: service as never }),
    });

    await expect(prepareRepositories()).resolves.toEqual({
      summary: "No project repositories are configured for this thread.",
    });
    expect(service.exec).not.toHaveBeenCalled();
  });
});
