import type { env } from "cloudflare:test";

const initializedRegistryDatabases = new WeakSet<object>();

export async function applyRegistryTestSchema(registryDb: typeof env.REGISTRY_DB) {
  if (initializedRegistryDatabases.has(registryDb)) return;

  const stmts = [
    "CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY NOT NULL, email text NOT NULL UNIQUE, name text, created_at integer NOT NULL, email_verified integer DEFAULT false NOT NULL, image text, updated_at integer NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, token text NOT NULL UNIQUE, expires_at integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, ip_address text, user_agent text, FOREIGN KEY (user_id) REFERENCES users(id))",
    "CREATE TABLE IF NOT EXISTS accounts (id text PRIMARY KEY NOT NULL, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL, access_token text, refresh_token text, id_token text, access_token_expires_at integer, refresh_token_expires_at integer, scope text, password text, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))",
    "CREATE TABLE IF NOT EXISTS verifications (id text PRIMARY KEY NOT NULL, identifier text NOT NULL UNIQUE, value text NOT NULL, expires_at integer NOT NULL, created_at integer, updated_at integer)",
    "CREATE TABLE IF NOT EXISTS invites (id text PRIMARY KEY NOT NULL, token text UNIQUE, inviter_user_id text NOT NULL, email text, status text DEFAULT 'pending' NOT NULL, accepted_user_id text, created_at integer NOT NULL, claimed_at integer, accepted_at integer, FOREIGN KEY (inviter_user_id) REFERENCES users(id), FOREIGN KEY (accepted_user_id) REFERENCES users(id))",
    "CREATE TABLE IF NOT EXISTS waiting_list (email text PRIMARY KEY NOT NULL, attempts integer DEFAULT 1 NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)",
    "CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY NOT NULL, name text NOT NULL, flags_json text DEFAULT '{}' NOT NULL, created_at integer NOT NULL)",
    "CREATE TABLE IF NOT EXISTS workspace_members (workspace_id text NOT NULL, user_id text NOT NULL, role text NOT NULL, created_at integer NOT NULL, PRIMARY KEY(workspace_id, user_id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (user_id) REFERENCES users(id))",
    "CREATE TABLE IF NOT EXISTS agents (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, name text NOT NULL, system_prompt text NOT NULL, provider text NOT NULL, model text NOT NULL, model_input_modalities text DEFAULT '[\"text\"]' NOT NULL, show_reasoning integer DEFAULT true NOT NULL, reasoning_effort text DEFAULT 'medium' NOT NULL, model_supports_reasoning integer, sandbox_enabled integer, sandbox_image text, sandbox_resource_profile text, sandbox_idle_timeout_ms integer, sandbox_max_process_runtime_ms integer, sandbox_network_domain_allowlist text, created_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE TABLE IF NOT EXISTS agent_memories (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, agent_id text NOT NULL, content text NOT NULL, title text, kind text DEFAULT 'fact' NOT NULL, source_thread_id text, created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (agent_id) REFERENCES agents(id))",
    "CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories (workspace_id, agent_id, archived_at, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_memories_source_thread ON agent_memories (source_thread_id)",
    "CREATE TABLE IF NOT EXISTS workspace_privacy_settings (workspace_id text PRIMARY KEY NOT NULL, telemetry_enabled integer DEFAULT false NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE TABLE IF NOT EXISTS agent_skills (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, agent_id text NOT NULL, name text NOT NULL, description text NOT NULL, body text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (agent_id) REFERENCES agents(id))",
    "CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills (workspace_id, agent_id, archived_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_skills_name ON agent_skills (workspace_id, agent_id, name)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_active_name_unique ON agent_skills (workspace_id, agent_id, name) WHERE archived_at IS NULL",
    "CREATE TABLE IF NOT EXISTS agent_skill_resources (id text PRIMARY KEY NOT NULL, skill_id text NOT NULL, path text NOT NULL, kind text NOT NULL, encoding text NOT NULL, mime_type text, content text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (skill_id) REFERENCES agent_skills(id) ON DELETE CASCADE)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skill_resources_skill_path ON agent_skill_resources (skill_id, path)",
    "CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, name text NOT NULL, description text DEFAULT '' NOT NULL, custom_instructions text DEFAULT '' NOT NULL, default_workbench_id text, archived_at integer, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE INDEX IF NOT EXISTS idx_projects_workspace_archived ON projects (workspace_id, archived_at)",
    "CREATE TABLE IF NOT EXISTS thread_index (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, agent_id text NOT NULL, project_id text, workbench_id text, workbench_switch_pending_at integer, model_provider text, model text, model_input_modalities text, show_reasoning integer, reasoning_effort text, model_supports_reasoning integer, kind text DEFAULT 'regular' NOT NULL, title text NOT NULL, title_set integer DEFAULT false NOT NULL, runtime text DEFAULT 'legacy' NOT NULL, source text NOT NULL, automaton_id text, automaton_run_id text, last_event_id text, last_message_preview text DEFAULT '' NOT NULL, activity_status text DEFAULT 'idle' NOT NULL, current_turn_started_at integer, attention_required_at integer, unread_outcome text, unread_outcome_at integer, outcome_dismissed_at integer, recent_dismissed_at integer, last_seen_at integer, archived_at integer, archive_skipped_updated_at integer, last_context_tokens integer, last_context_window integer, last_compact_after_tokens integer, search_indexed_through integer, search_repair_attempts integer, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (agent_id) REFERENCES agents(id))",
    "CREATE INDEX IF NOT EXISTS idx_thread_index_workspace_project_updated ON thread_index (workspace_id, project_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_thread_index_workspace_attention ON thread_index (workspace_id, attention_required_at)",
    "CREATE INDEX IF NOT EXISTS idx_thread_index_workspace_unread ON thread_index (workspace_id, unread_outcome_at)",
    "CREATE TABLE IF NOT EXISTS thread_search_messages (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, workspace_id text NOT NULL, thread_id text NOT NULL, message_id text NOT NULL, role text NOT NULL, created_at integer, content text NOT NULL, content_hash text NOT NULL, source_hash text NOT NULL, indexed_revision integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (thread_id) REFERENCES thread_index(id) ON DELETE CASCADE)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_search_messages_thread_message ON thread_search_messages (thread_id, message_id)",
    "CREATE INDEX IF NOT EXISTS idx_thread_search_messages_workspace_thread ON thread_search_messages (workspace_id, thread_id)",
    "CREATE INDEX IF NOT EXISTS idx_thread_search_messages_thread_created ON thread_search_messages (thread_id, created_at)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS thread_search_fts USING fts5(content, content='thread_search_messages', content_rowid='id', tokenize='unicode61')",
    "CREATE TRIGGER IF NOT EXISTS thread_search_messages_ai AFTER INSERT ON thread_search_messages BEGIN INSERT INTO thread_search_fts(rowid, content) VALUES (new.id, new.content); END",
    "CREATE TRIGGER IF NOT EXISTS thread_search_messages_ad AFTER DELETE ON thread_search_messages BEGIN INSERT INTO thread_search_fts(thread_search_fts, rowid, content) VALUES ('delete', old.id, old.content); END",
    "CREATE TRIGGER IF NOT EXISTS thread_search_messages_au AFTER UPDATE OF content ON thread_search_messages BEGIN INSERT INTO thread_search_fts(thread_search_fts, rowid, content) VALUES ('delete', old.id, old.content); INSERT INTO thread_search_fts(rowid, content) VALUES (new.id, new.content); END",
    "CREATE TABLE IF NOT EXISTS thread_repository_snapshots (id text PRIMARY KEY NOT NULL, thread_id text NOT NULL, workspace_id text NOT NULL, project_id text, workbench_id text, name text NOT NULL, url text NOT NULL, default_branch text NOT NULL, checkout_path_name text NOT NULL, root_directory text DEFAULT '' NOT NULL, setup_command text DEFAULT '' NOT NULL, package_manager text DEFAULT '' NOT NULL, created_at integer NOT NULL, FOREIGN KEY (thread_id) REFERENCES thread_index(id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (project_id) REFERENCES projects(id))",
    "CREATE INDEX IF NOT EXISTS idx_thread_repository_snapshots_thread ON thread_repository_snapshots (thread_id)",
    "CREATE INDEX IF NOT EXISTS idx_thread_repository_snapshots_workspace ON thread_repository_snapshots (workspace_id)",
    "CREATE TABLE IF NOT EXISTS github_app_installations (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, installation_id integer NOT NULL, account_login text NOT NULL, account_type text NOT NULL, repository_selection text NOT NULL, connected_by_user_id text NOT NULL, status text DEFAULT 'active' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE INDEX IF NOT EXISTS idx_github_app_installations_workspace ON github_app_installations (workspace_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uidx_github_app_installations_ws_installation ON github_app_installations (workspace_id, installation_id)",
    "CREATE TABLE IF NOT EXISTS workbenches (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, name text NOT NULL, description text DEFAULT '' NOT NULL, setup_script text DEFAULT '' NOT NULL, resource_profile text DEFAULT 'small' NOT NULL, sandbox_env_vars_json text DEFAULT '{}' NOT NULL, sandbox_network_domain_allowlist text DEFAULT '' NOT NULL, secret_names_backfilled integer DEFAULT false NOT NULL, archived_at integer, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE INDEX IF NOT EXISTS idx_workbenches_workspace_archived ON workbenches (workspace_id, archived_at)",
    "CREATE TABLE IF NOT EXISTS workbench_secret_names (workbench_id text NOT NULL, name text NOT NULL, updated_at integer NOT NULL, PRIMARY KEY (workbench_id, name), FOREIGN KEY (workbench_id) REFERENCES workbenches(id))",
    "CREATE TABLE IF NOT EXISTS workbench_repositories (id text PRIMARY KEY NOT NULL, workbench_id text NOT NULL, source text NOT NULL, name text NOT NULL, url text NOT NULL, github_repo_id integer, source_installation_id text, access_status text DEFAULT 'ok' NOT NULL, checkout_path_name text NOT NULL, default_branch text DEFAULT 'main' NOT NULL, root_directory text DEFAULT '' NOT NULL, setup_command text DEFAULT '' NOT NULL, package_manager text DEFAULT '' NOT NULL, created_at integer NOT NULL, FOREIGN KEY (workbench_id) REFERENCES workbenches(id), FOREIGN KEY (source_installation_id) REFERENCES github_app_installations(id))",
    "CREATE INDEX IF NOT EXISTS idx_workbench_repositories_workbench ON workbench_repositories (workbench_id)",
    "CREATE TABLE IF NOT EXISTS thread_workbench_snapshots (thread_id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, workbench_id text, name text NOT NULL, setup_script text DEFAULT '' NOT NULL, resource_profile text, created_at integer NOT NULL, FOREIGN KEY (thread_id) REFERENCES thread_index(id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE TABLE IF NOT EXISTS archived_message (thread_id text NOT NULL, seq integer NOT NULL, payload text NOT NULL, PRIMARY KEY(thread_id, seq))",
    "CREATE TABLE IF NOT EXISTS archived_compaction (thread_id text NOT NULL, seq integer NOT NULL, compaction_id text NOT NULL, from_message_id text NOT NULL, to_message_id text NOT NULL, summary text NOT NULL, PRIMARY KEY(thread_id, seq))",
    "CREATE TABLE IF NOT EXISTS mcp_servers (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, name text NOT NULL, url text NOT NULL, enabled integer DEFAULT true NOT NULL, created_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE TABLE IF NOT EXISTS mcp_tool_policies (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, server_id text NOT NULL, tool_name text NOT NULL, policy text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (server_id) REFERENCES mcp_servers(id))",
    "CREATE TABLE IF NOT EXISTS provider_configs (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, provider text NOT NULL, display_name text NOT NULL, secret_name text NOT NULL, config_json text, created_at integer NOT NULL DEFAULT (unixepoch() * 1000), FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE TABLE IF NOT EXISTS provider_model_whitelists (workspace_id text NOT NULL, provider text NOT NULL, models_json text NOT NULL, updated_at integer NOT NULL, PRIMARY KEY (workspace_id, provider), FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE TABLE IF NOT EXISTS model_capability_catalog (id text PRIMARY KEY NOT NULL, payload_json text NOT NULL, fetched_at integer NOT NULL)",
    "CREATE TABLE IF NOT EXISTS provider_model_catalogs (workspace_id text NOT NULL, provider text NOT NULL, models_json text NOT NULL, source text NOT NULL, fetched_at integer NOT NULL, PRIMARY KEY (workspace_id, provider), FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    // This helper does NOT replay migrations/ — extraction columns added by 0026 must be mirrored here by hand.
    "CREATE TABLE IF NOT EXISTS attachments (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, thread_id text NOT NULL, mime_type text NOT NULL, byte_size integer NOT NULL, width integer, height integer, r2_key text NOT NULL, status text DEFAULT 'pending' NOT NULL, extracted_text text, extracted_source text, extracted_at integer, extracted_error text, extracted_attempts integer DEFAULT 0 NOT NULL, created_at integer NOT NULL)",
    "CREATE TABLE IF NOT EXISTS workspace_sandbox_settings (workspace_id text PRIMARY KEY NOT NULL, enabled integer DEFAULT false NOT NULL, provider text DEFAULT 'daytona' NOT NULL, provider_config_json text, default_resource_profile text DEFAULT 'small' NOT NULL, image text DEFAULT '' NOT NULL, snapshot text, small_snapshot text, medium_snapshot text, daytona_api_key_secret_name text DEFAULT 'sandbox:daytona' NOT NULL, daytona_api_url text, daytona_target text, idle_timeout_ms integer DEFAULT 900000 NOT NULL, recovery_ttl_ms integer DEFAULT 86400000 NOT NULL, max_process_runtime_ms integer DEFAULT 600000 NOT NULL, limits_json text DEFAULT '{}' NOT NULL, network_restriction_enabled integer DEFAULT 0 NOT NULL, network_domain_allowlist text DEFAULT '' NOT NULL, created_at integer NOT NULL DEFAULT (unixepoch() * 1000), updated_at integer NOT NULL DEFAULT (unixepoch() * 1000), FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE TABLE IF NOT EXISTS active_containers (thread_id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, provider text NOT NULL, profile text NOT NULL, last_used_at integer NOT NULL, expires_at integer NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_active_containers_ws ON active_containers (workspace_id, expires_at)",
    "CREATE TABLE IF NOT EXISTS push_subscriptions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, endpoint text NOT NULL, p256dh text NOT NULL, auth text NOT NULL, user_agent text, last_seen_at integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint_unique ON push_subscriptions (endpoint)",
    "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id)",
    "CREATE TABLE IF NOT EXISTS user_notification_settings (user_id text PRIMARY KEY NOT NULL, browser_push_enabled integer DEFAULT false NOT NULL, push_preview_enabled integer DEFAULT true NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)",
    "CREATE TABLE IF NOT EXISTS user_voice_settings (user_id text PRIMARY KEY NOT NULL, language text DEFAULT 'en' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))",
    "CREATE TABLE IF NOT EXISTS automata (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, owner_user_id text NOT NULL, agent_id text NOT NULL, project_id text, workbench_id text, name text NOT NULL, prompt text NOT NULL, model_provider text, model text, model_input_modalities text, schedule_json text NOT NULL, timezone text NOT NULL, enabled integer DEFAULT true NOT NULL, disabled_reason text, notify_mode text DEFAULT 'all' NOT NULL, next_due_at integer, last_fired_at integer, archived_at integer, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (owner_user_id) REFERENCES users(id), FOREIGN KEY (agent_id) REFERENCES agents(id))",
    "CREATE INDEX IF NOT EXISTS idx_automata_due ON automata (enabled, next_due_at)",
    "CREATE INDEX IF NOT EXISTS idx_automata_workspace ON automata (workspace_id, archived_at)",
    "CREATE TABLE IF NOT EXISTS automaton_runs (id text PRIMARY KEY NOT NULL, automaton_id text NOT NULL, workspace_id text NOT NULL, due_at integer, trigger text NOT NULL, thread_id text, status text NOT NULL, error text, started_at integer, finished_at integer, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (automaton_id) REFERENCES automata(id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id))",
    "CREATE INDEX IF NOT EXISTS idx_automaton_runs_automaton ON automaton_runs (automaton_id, created_at)",
    // The dedupe lease. Partial on trigger='scheduled' so two manual runs (both due_at NULL) never collide.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_automaton_runs_due ON automaton_runs (automaton_id, due_at) WHERE \"trigger\" = 'scheduled'",
    "CREATE TABLE IF NOT EXISTS thread_token_usage (thread_id text NOT NULL, workspace_id text NOT NULL, agent_id text NOT NULL, provider text NOT NULL, model text NOT NULL, source text NOT NULL, input_tokens integer DEFAULT 0 NOT NULL, cached_input_tokens integer DEFAULT 0 NOT NULL, cache_write_tokens integer DEFAULT 0 NOT NULL, output_tokens integer DEFAULT 0 NOT NULL, reasoning_tokens integer DEFAULT 0 NOT NULL, calls integer DEFAULT 0 NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_token_usage_key ON thread_token_usage (thread_id, provider, model, source)",
    "CREATE INDEX IF NOT EXISTS idx_thread_token_usage_thread ON thread_token_usage (thread_id)",
    "CREATE INDEX IF NOT EXISTS idx_thread_token_usage_workspace ON thread_token_usage (workspace_id)",
    "CREATE TABLE IF NOT EXISTS feedback_threads (user_id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, thread_id text NOT NULL UNIQUE, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (thread_id) REFERENCES thread_index(id))",
    "CREATE TABLE IF NOT EXISTS feedback_reports (id text PRIMARY KEY NOT NULL, reporter_user_id text NOT NULL, workspace_id text NOT NULL, thread_id text NOT NULL, interview_id text NOT NULL, from_message_id text NOT NULL, to_message_id text NOT NULL, category text NOT NULL, title text NOT NULL, narrative text NOT NULL, reproduction_steps_json text NOT NULL, expected_behavior text, actual_behavior text, frequency text, impact text, diagnostics_json text NOT NULL, idempotency_key text NOT NULL UNIQUE, submitted_at integer NOT NULL, FOREIGN KEY (reporter_user_id) REFERENCES users(id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id), FOREIGN KEY (thread_id) REFERENCES thread_index(id))",
    "CREATE INDEX IF NOT EXISTS idx_feedback_reports_submitted ON feedback_reports (submitted_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_feedback_reports_reporter ON feedback_reports (reporter_user_id, submitted_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_reports_interview ON feedback_reports (thread_id, interview_id)",
    "CREATE TABLE IF NOT EXISTS feedback_report_attachments (report_id text NOT NULL, attachment_id text NOT NULL, ordinal integer NOT NULL, PRIMARY KEY(report_id, attachment_id), FOREIGN KEY (report_id) REFERENCES feedback_reports(id), FOREIGN KEY (attachment_id) REFERENCES attachments(id))",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_report_attachment_order ON feedback_report_attachments (report_id, ordinal)",
    "CREATE TABLE IF NOT EXISTS feedback_admin_reads (report_id text NOT NULL, admin_user_id text NOT NULL, seen_at integer NOT NULL, PRIMARY KEY(report_id, admin_user_id), FOREIGN KEY (report_id) REFERENCES feedback_reports(id), FOREIGN KEY (admin_user_id) REFERENCES users(id))",
  ];

  for (const sql of stmts) {
    await registryDb.prepare(sql).run();
  }

  const automataColumns = await registryDb
    .prepare("PRAGMA table_info(automata)")
    .all<{ name: string }>();
  if (!automataColumns.results.some((column) => column.name === "disabled_reason")) {
    await registryDb.prepare("ALTER TABLE automata ADD COLUMN disabled_reason text").run();
  }

  const workspaceSandboxColumns = await registryDb
    .prepare("PRAGMA table_info(workspace_sandbox_settings)")
    .all<{ name: string }>();
  if (!workspaceSandboxColumns.results.some((column) => column.name === "snapshot")) {
    await registryDb
      .prepare("ALTER TABLE workspace_sandbox_settings ADD COLUMN snapshot text")
      .run();
  }
  const workspaceSandboxColumnNames = new Set(
    workspaceSandboxColumns.results.map((column) => column.name),
  );
  if (!workspaceSandboxColumnNames.has("network_restriction_enabled")) {
    await registryDb
      .prepare(
        "ALTER TABLE workspace_sandbox_settings ADD COLUMN network_restriction_enabled integer NOT NULL DEFAULT 0",
      )
      .run();
  }
  if (!workspaceSandboxColumnNames.has("small_snapshot")) {
    await registryDb
      .prepare("ALTER TABLE workspace_sandbox_settings ADD COLUMN small_snapshot text")
      .run();
  }
  if (!workspaceSandboxColumnNames.has("medium_snapshot")) {
    await registryDb
      .prepare("ALTER TABLE workspace_sandbox_settings ADD COLUMN medium_snapshot text")
      .run();
  }
  if (!workspaceSandboxColumnNames.has("network_domain_allowlist")) {
    await registryDb
      .prepare(
        "ALTER TABLE workspace_sandbox_settings ADD COLUMN network_domain_allowlist text NOT NULL DEFAULT ''",
      )
      .run();
  }
  if (!workspaceSandboxColumnNames.has("env_vars_json")) {
    await registryDb
      .prepare("ALTER TABLE workspace_sandbox_settings ADD COLUMN env_vars_json text")
      .run();
  }
  if (!workspaceSandboxColumnNames.has("provider_config_json")) {
    await registryDb
      .prepare("ALTER TABLE workspace_sandbox_settings ADD COLUMN provider_config_json text")
      .run();
  }
  if (!workspaceSandboxColumnNames.has("default_resource_profile")) {
    await registryDb
      .prepare(
        "ALTER TABLE workspace_sandbox_settings ADD COLUMN default_resource_profile text NOT NULL DEFAULT 'small'",
      )
      .run();
  }
  if (!workspaceSandboxColumnNames.has("recovery_ttl_ms")) {
    await registryDb
      .prepare(
        "ALTER TABLE workspace_sandbox_settings ADD COLUMN recovery_ttl_ms integer NOT NULL DEFAULT 86400000",
      )
      .run();
  }

  const providerConfigColumns = await registryDb
    .prepare("PRAGMA table_info(provider_configs)")
    .all<{ name: string }>();
  if (!providerConfigColumns.results.some((column) => column.name === "config_json")) {
    await registryDb.prepare("ALTER TABLE provider_configs ADD COLUMN config_json text").run();
  }

  const notificationSettingsColumns = await registryDb
    .prepare("PRAGMA table_info(user_notification_settings)")
    .all<{ name: string }>();
  if (
    !notificationSettingsColumns.results.some((column) => column.name === "browser_push_enabled")
  ) {
    await registryDb
      .prepare(
        "ALTER TABLE user_notification_settings ADD COLUMN browser_push_enabled integer DEFAULT false NOT NULL",
      )
      .run();
  }
  if (
    !notificationSettingsColumns.results.some((column) => column.name === "push_preview_enabled")
  ) {
    await registryDb
      .prepare(
        "ALTER TABLE user_notification_settings ADD COLUMN push_preview_enabled integer DEFAULT true NOT NULL",
      )
      .run();
  }

  const agentColumns = await registryDb
    .prepare("PRAGMA table_info(agents)")
    .all<{ name: string }>();
  if (!agentColumns.results.some((column) => column.name === "model_input_modalities")) {
    await registryDb
      .prepare(
        "ALTER TABLE agents ADD COLUMN model_input_modalities text DEFAULT '[\"text\"]' NOT NULL",
      )
      .run();
  }
  if (!agentColumns.results.some((column) => column.name === "sandbox_resource_profile")) {
    await registryDb.prepare("ALTER TABLE agents ADD COLUMN sandbox_resource_profile text").run();
  }
  const agentColumnNames = new Set(agentColumns.results.map((column) => column.name));
  if (!agentColumnNames.has("sandbox_enabled")) {
    await registryDb.prepare("ALTER TABLE agents ADD COLUMN sandbox_enabled integer").run();
  }
  if (!agentColumnNames.has("sandbox_image")) {
    await registryDb.prepare("ALTER TABLE agents ADD COLUMN sandbox_image text").run();
  }
  if (!agentColumnNames.has("sandbox_snapshot")) {
    await registryDb.prepare("ALTER TABLE agents ADD COLUMN sandbox_snapshot text").run();
  }
  if (!agentColumnNames.has("sandbox_idle_timeout_ms")) {
    await registryDb.prepare("ALTER TABLE agents ADD COLUMN sandbox_idle_timeout_ms integer").run();
  }
  if (!agentColumnNames.has("sandbox_max_process_runtime_ms")) {
    await registryDb
      .prepare("ALTER TABLE agents ADD COLUMN sandbox_max_process_runtime_ms integer")
      .run();
  }
  if (!agentColumnNames.has("sandbox_network_domain_allowlist")) {
    await registryDb
      .prepare("ALTER TABLE agents ADD COLUMN sandbox_network_domain_allowlist text")
      .run();
  }
  if (!agentColumnNames.has("sandbox_env_vars_json")) {
    await registryDb.prepare("ALTER TABLE agents ADD COLUMN sandbox_env_vars_json text").run();
  }

  const agentSkillColumns = await registryDb
    .prepare("PRAGMA table_info(agent_skills)")
    .all<{ name: string }>();
  if (!agentSkillColumns.results.some((column) => column.name === "enabled")) {
    await registryDb
      .prepare("ALTER TABLE agent_skills ADD COLUMN enabled integer DEFAULT 1 NOT NULL")
      .run();
  }
  if (!agentSkillColumns.results.some((column) => column.name === "network_domains")) {
    await registryDb.prepare("ALTER TABLE agent_skills ADD COLUMN network_domains text").run();
  }

  const threadColumns = await registryDb
    .prepare("PRAGMA table_info(thread_index)")
    .all<{ name: string }>();
  const threadColumnNames = new Set(threadColumns.results.map((column) => column.name));
  if (!threadColumnNames.has("model_provider")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN model_provider text").run();
  }
  if (!threadColumnNames.has("model")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN model text").run();
  }
  if (!threadColumnNames.has("model_input_modalities")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN model_input_modalities text")
      .run();
  }
  if (!threadColumnNames.has("show_reasoning")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN show_reasoning integer").run();
  }
  if (!threadColumnNames.has("kind")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN kind text DEFAULT 'regular' NOT NULL")
      .run();
  }
  if (!threadColumnNames.has("archived_at")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN archived_at integer").run();
  }
  if (!threadColumnNames.has("archive_skipped_updated_at")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN archive_skipped_updated_at integer")
      .run();
  }
  if (!threadColumnNames.has("project_id")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN project_id text").run();
  }
  if (!threadColumnNames.has("activity_status")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN activity_status text DEFAULT 'idle' NOT NULL")
      .run();
  }
  if (!threadColumnNames.has("current_turn_started_at")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN current_turn_started_at integer")
      .run();
  }
  if (!threadColumnNames.has("attention_required_at")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN attention_required_at integer")
      .run();
  }
  if (!threadColumnNames.has("unread_outcome")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN unread_outcome text").run();
  }
  if (!threadColumnNames.has("unread_outcome_at")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN unread_outcome_at integer").run();
  }
  if (!threadColumnNames.has("recent_dismissed_at")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN recent_dismissed_at integer")
      .run();
  }
  if (!threadColumnNames.has("last_seen_at")) {
    await registryDb.prepare("ALTER TABLE thread_index ADD COLUMN last_seen_at integer").run();
  }
  if (!threadColumnNames.has("search_indexed_through")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN search_indexed_through integer")
      .run();
  }
  if (!threadColumnNames.has("search_repair_attempts")) {
    await registryDb
      .prepare("ALTER TABLE thread_index ADD COLUMN search_repair_attempts integer")
      .run();
  }
  await registryDb
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_thread_index_workspace_project_updated ON thread_index (workspace_id, project_id, updated_at)",
    )
    .run();
  await registryDb
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_thread_index_workspace_attention ON thread_index (workspace_id, attention_required_at)",
    )
    .run();
  await registryDb
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_thread_index_workspace_unread ON thread_index (workspace_id, unread_outcome_at)",
    )
    .run();

  const attachmentColumns = await registryDb
    .prepare("PRAGMA table_info(attachments)")
    .all<{ name: string }>();
  if (!attachmentColumns.results.some((column) => column.name === "filename")) {
    await registryDb.prepare("ALTER TABLE attachments ADD COLUMN filename text").run();
  }

  initializedRegistryDatabases.add(registryDb);
}

export async function seedRegistryThread(
  registryDb: typeof env.REGISTRY_DB,
  input?: {
    workspaceId?: string;
    agentId?: string;
    threadId?: string;
    title?: string;
    titleSet?: boolean;
    runtime?: "legacy" | "think";
    provider?: string;
    model?: string;
    projectId?: string | null;
    createdAt?: number;
    updatedAt?: number;
    archivedAt?: number | null;
  },
) {
  const createdAt = input?.createdAt ?? 1_800_000_000_000;
  const threadId = input?.threadId ?? "test-thread";
  const workspaceId = input?.workspaceId ?? "workspace-test";
  const agentId = input?.agentId ?? `agent-${workspaceId}`;
  const provider = input?.provider ?? "mock";
  const model = input?.model ?? "mock";

  await registryDb
    .prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind(workspaceId, workspaceId, createdAt)
    .run();
  await registryDb
    .prepare(
      "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(agentId, workspaceId, "Default", "You are Nadi.", provider, model, createdAt)
    .run();
  await registryDb
    .prepare(
      "INSERT OR IGNORE INTO thread_index (id, workspace_id, agent_id, project_id, title, title_set, runtime, source, automaton_id, automaton_run_id, last_event_id, last_message_preview, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      threadId,
      workspaceId,
      agentId,
      input?.projectId ?? null,
      input?.title ?? "Test Thread",
      input?.titleSet ? 1 : 0,
      input?.runtime ?? "legacy",
      "manual",
      null,
      null,
      null,
      "",
      input?.archivedAt ?? null,
      createdAt,
      input?.updatedAt ?? createdAt,
    )
    .run();

  return { threadId, workspaceId, agentId };
}
