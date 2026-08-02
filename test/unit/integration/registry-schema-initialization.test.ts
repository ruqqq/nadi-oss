import { describe, expect, it } from "vitest";
import { applyRegistryTestSchema } from "../../integration/helpers/registry";

const existingColumns = [
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

function fakeRegistryDatabase() {
  let statementCount = 0;

  const registryDb = {
    prepare(sql: string) {
      statementCount++;
      return {
        async run() {
          return {};
        },
        async all() {
          if (sql.startsWith("PRAGMA table_info")) {
            return { results: existingColumns.map((name) => ({ name })) };
          }
          return { results: [] };
        },
      };
    },
  };

  return {
    registryDb: registryDb as unknown as Parameters<typeof applyRegistryTestSchema>[0],
    get statementCount() {
      return statementCount;
    },
  };
}

describe("applyRegistryTestSchema", () => {
  it("initializes each registry database only once", async () => {
    const database = fakeRegistryDatabase();

    await applyRegistryTestSchema(database.registryDb);
    const statementsAfterFirstCall = database.statementCount;

    await applyRegistryTestSchema(database.registryDb);

    expect(statementsAfterFirstCall).toBeGreaterThan(0);
    expect(database.statementCount).toBe(statementsAfterFirstCall);
  });
});
