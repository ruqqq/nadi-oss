import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  agents,
  agentMemories,
  agentSkills,
  automata,
  automatonRuns,
  pushSubscriptions,
  projects,
  threadIndex,
  threadRepositorySnapshots,
  userNotificationSettings,
  users,
  verifications,
  workbenchRepositories,
  workspaceMembers,
  workspaces,
} from "../../../src/db/schema";

describe("registry schema", () => {
  it("exports the core registry tables", () => {
    expect(users).toBeDefined();
    expect(workspaces).toBeDefined();
    expect(workspaceMembers).toBeDefined();
    expect(agents).toBeDefined();
    expect(agentMemories).toBeDefined();
    expect(agentSkills).toBeDefined();
    expect(threadIndex).toBeDefined();
    expect(automata).toBeDefined();
    expect(automatonRuns).toBeDefined();
  });

  it("exports project scoped conversation tables", () => {
    expect(projects).toBeDefined();
    expect(workbenchRepositories).toBeDefined();
    expect(threadRepositorySnapshots).toBeDefined();
    expect(threadIndex.projectId.name).toBe("project_id");
  });

  it("exports notification tables and thread activity columns", () => {
    expect(pushSubscriptions).toBeDefined();
    expect(userNotificationSettings).toBeDefined();
    expect(threadIndex.activityStatus).toBeDefined();
    expect(threadIndex.currentTurnStartedAt).toBeDefined();
    expect(threadIndex.attentionRequiredAt).toBeDefined();
    expect(threadIndex.unreadOutcome).toBeDefined();
    expect(threadIndex.unreadOutcomeAt).toBeDefined();
    expect(threadIndex.lastSeenAt).toBeDefined();
  });

  it("indexes agent memories by agent scope and source thread", () => {
    const config = getTableConfig(agentMemories);

    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining(["idx_agent_memories_agent", "idx_agent_memories_source_thread"]),
    );
  });

  it("keeps email OTP identifiers unique", () => {
    const config = getTableConfig(verifications);
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "verifications_identifier_unique",
    );
  });

  it("defines a sticky runtime column on thread_index", () => {
    const config = getTableConfig(threadIndex);
    const runtime = config.columns.find((column) => column.name === "runtime");

    expect(runtime).toBeDefined();
    expect(runtime?.notNull).toBe(true);
    expect(runtime?.default).toBe("legacy");
  });

  it("defines thread model snapshot columns on thread_index", () => {
    const config = getTableConfig(threadIndex);

    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "model_provider",
        "model",
        "model_input_modalities",
        "show_reasoning",
      ]),
    );
  });

  it("exports the automata tables under their new names", () => {
    expect(getTableConfig(automata).name).toBe("automata");
    expect(getTableConfig(automatonRuns).name).toBe("automaton_runs");
  });

  it("stores a visible disabled reason on automata", () => {
    const columns = getTableConfig(automata).columns.map((column) => column.name);
    expect(columns).toContain("disabled_reason");
  });

  it("dedupes scheduled runs with a partial unique index", () => {
    const idx = getTableConfig(automatonRuns).indexes.find(
      (i) => i.config.name === "idx_automaton_runs_due",
    );
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    // Partial: manual runs are excluded, so two manual runs can never collide.
    expect(idx!.config.where).toBeDefined();
  });

  it("threads point back at the automaton run that created them", () => {
    const columns = getTableConfig(threadIndex).columns.map((c) => c.name);
    expect(columns).toContain("automaton_id");
    expect(columns).toContain("automaton_run_id");
    expect(columns).not.toContain("routine_id");
  });

  it("defines agent-scoped skills indexes", () => {
    const config = getTableConfig(agentSkills);

    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "workspace_id",
      "agent_id",
      "name",
      "description",
      "body",
      "network_domains",
      "enabled",
      "created_at",
      "updated_at",
      "archived_at",
    ]);
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual([
      "idx_agent_skills_active_name_unique",
      "idx_agent_skills_agent",
      "idx_agent_skills_name",
    ]);
  });
});
