import { describe, expect, it } from "vitest";
import { createTestNamespace, resetRegistryState } from "../../integration/helpers/reset";

const columns = [
  "disabled_reason",
  "snapshot",
  "network_restriction_enabled",
  "small_snapshot",
  "medium_snapshot",
  "network_domain_allowlist",
  "env_vars_json",
  "provider_config_json",
  "default_resource_profile",
  "recovery_ttl_ms",
  "config_json",
  "browser_push_enabled",
  "model_input_modalities",
  "sandbox_resource_profile",
  "sandbox_enabled",
  "sandbox_image",
  "sandbox_snapshot",
  "sandbox_idle_timeout_ms",
  "sandbox_max_process_runtime_ms",
  "sandbox_network_domain_allowlist",
  "sandbox_env_vars_json",
  "enabled",
  "network_domains",
  "model_provider",
  "model",
  "show_reasoning",
  "archived_at",
  "archive_skipped_updated_at",
  "project_id",
  "activity_status",
  "current_turn_started_at",
  "attention_required_at",
  "unread_outcome",
  "unread_outcome_at",
  "last_seen_at",
  "filename",
];

function fakeDatabase() {
  const batches: string[][] = [];
  const d1 = {
    prepare(sql: string) {
      return {
        sql,
        async run() {
          return {};
        },
        async all() {
          return { results: columns.map((name) => ({ name })) };
        },
      };
    },
    async batch(statements: Array<{ sql: string }>) {
      batches.push(statements.map((statement) => statement.sql));
      return [];
    },
  };
  return { d1, batches };
}

describe("integration reset harness", () => {
  it("clears the registry in a single foreign-key-safe batch", async () => {
    const database = fakeDatabase();

    await resetRegistryState(database.d1 as never);

    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]?.slice(0, 2)).toEqual([
      "DELETE FROM automaton_runs",
      "DELETE FROM active_containers",
    ]);
    expect(database.batches[0]).toHaveLength(47);
    expect(database.batches[0]).toContain("DELETE FROM artifacts");
    expect(database.batches[0]?.at(-1)).toBe("DELETE FROM users");
  });

  it("creates unique namespaces", () => {
    expect(createTestNamespace()).not.toBe(createTestNamespace());
  });
});
