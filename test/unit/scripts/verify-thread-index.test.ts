import { describe, expect, it } from "vitest";

describe("verify-thread-index script helpers", () => {
  it("builds idempotent default thread_index backfill statements", async () => {
    const { buildBackfillStatements } =
      (await import("../../../scripts/verify-thread-index.mjs")) as {
        buildBackfillStatements: () => string[];
      };

    expect(buildBackfillStatements()).toEqual([
      "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('default', 'Default Workspace', 1766880000000)",
      "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES ('agent_default', 'default', 'Default Agent', 'You are Nadi, a helpful AI assistant. Be concise and clear.', 'openai-oauth', 'gpt-5.4-mini', 1766880000000)",
      "INSERT OR IGNORE INTO thread_index (id, workspace_id, agent_id, title, source, automaton_id, automaton_run_id, last_event_id, last_message_preview, created_at, updated_at) VALUES ('default', 'default', 'agent_default', 'Default', 'manual', NULL, NULL, NULL, '', 1766880000000, 1766880000000)",
    ]);
  });

  it("parses orphan counts from wrangler json output", async () => {
    const { parseOrphanCounts } = (await import("../../../scripts/verify-thread-index.mjs")) as {
      parseOrphanCounts: (raw: string) => { workspaceOrphans: number; agentOrphans: number };
    };

    expect(
      parseOrphanCounts(
        JSON.stringify([
          {
            results: [{ workspace_orphans: 1, agent_orphans: 2 }],
            success: true,
          },
        ]),
      ),
    ).toEqual({ workspaceOrphans: 1, agentOrphans: 2 });
  });
});
