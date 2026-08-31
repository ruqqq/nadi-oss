import type { env } from "cloudflare:test";
import { applyRegistryTestSchema } from "./registry";

// Children before parents: every DELETE runs with foreign keys enforced.
const registryTables = [
  "automaton_runs",
  "active_containers",
  "archived_compaction",
  "automata",
  "agent_sandboxes",
  "agent_skill_resources",
  "agent_skill_exclusions",
  "agent_memories",
  "skills",
  "feedback_admin_reads",
  "feedback_report_attachments",
  "feedback_reports",
  "feedback_threads",
  "attachments",
  "artifacts",
  "thread_token_usage",
  "agent_repositories",
  "agent_secret_names",
  "mcp_tool_policies",
  "mcp_servers",
  "provider_model_whitelists",
  "provider_model_catalogs",
  // Global, no FK to workspaces — position is not load-bearing, but it must be
  // cleared or capability leaks between tests.
  "model_capability_catalog",
  "provider_configs",
  "push_subscriptions",
  "user_notification_settings",
  "user_voice_settings",
  "user_preferences",
  "sessions",
  "archived_message",
  "thread_search_messages",
  "thread_index",
  "verifications",
  "workspace_members",
  "workspace_privacy_settings",
  "workspace_sandbox_settings",
  "accounts",
  // Before `agents`: `projects.default_agent_id` FKs it now.
  "projects",
  "agents",
  "invites",
  "waiting_list",
  "github_app_installations",
  "workspaces",
  "users",
];

export async function resetRegistryState(registryDb: typeof env.REGISTRY_DB) {
  await applyRegistryTestSchema(registryDb);
  await registryDb.batch(registryTables.map((table) => registryDb.prepare(`DELETE FROM ${table}`)));
}

export function createTestNamespace() {
  return crypto.randomUUID();
}
