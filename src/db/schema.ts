import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  // Better Auth manages users and passes Date objects; timestamp_ms mode converts them to integers.
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  token: text("token").notNull().unique(),
  // Better Auth manages sessions and passes Date objects; timestamp_ms mode converts them.
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    identifierUnique: uniqueIndex("verifications_identifier_unique").on(table.identifier),
  }),
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  flagsJson: text("flags_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
  }),
);

/**
 * Sign-in invites. A link invite is created with a token and no email
 * (`pending`), gets bound to an email when the recipient opens the link
 * (`claimed`), and consumes one of the inviter's quota slots only once that
 * email actually signs in (`accepted`). A direct invite (superuser inviting a
 * waiting-list email) skips the token and starts at `claimed`.
 */
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    inviterUserId: text("inviter_user_id")
      .notNull()
      .references(() => users.id),
    email: text("email"),
    status: text("status", { enum: ["pending", "claimed", "accepted"] })
      .notNull()
      .default("pending"),
    acceptedUserId: text("accepted_user_id").references(() => users.id),
    createdAt: integer("created_at").notNull(),
    claimedAt: integer("claimed_at"),
    acceptedAt: integer("accepted_at"),
  },
  (table) => ({
    byEmail: index("idx_invites_email").on(table.email),
    byInviter: index("idx_invites_inviter").on(table.inviterUserId),
  }),
);

/** Emails that tried to sign in without an invite. */
export const waitingList = sqliteTable("waiting_list", {
  email: text("email").primaryKey(),
  attempts: integer("attempts").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelInputModalities: text("model_input_modalities").notNull().default('["text"]'),
    showReasoning: integer("show_reasoning", { mode: "boolean" }).notNull().default(true),
    /** Workspace default thinking effort: "off" | "low" | "medium" | "high".
     *  Distinct from showReasoning, which only decides whether the thinking is
     *  DISPLAYED. */
    reasoningEffort: text("reasoning_effort").notNull().default("medium"),
    /** Whether the default model can reason. Nullable because NULL means
     *  UNKNOWN — a default of 0 would assert every existing model cannot think. */
    modelSupportsReasoning: integer("model_supports_reasoning", { mode: "boolean" }),
    sandboxEnabled: integer("sandbox_enabled", { mode: "boolean" }),
    sandboxImage: text("sandbox_image"),
    sandboxSnapshot: text("sandbox_snapshot"),
    // DEAD: superseded by workbenches.resourceProfile. No reader or writer
    // remains. Kept so drizzle stays in sync with the deployed DB; dropped in
    // the follow-up cleanup ticket alongside the legacy snapshot columns.
    sandboxResourceProfile: text("sandbox_resource_profile"),
    sandboxIdleTimeoutMs: integer("sandbox_idle_timeout_ms"),
    sandboxMaxProcessRuntimeMs: integer("sandbox_max_process_runtime_ms"),
    sandboxNetworkDomainAllowlist: text("sandbox_network_domain_allowlist"),
    sandboxEnvVarsJson: text("sandbox_env_vars_json"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_agents_workspace").on(table.workspaceId),
  }),
);

export const workspaceSandboxSettings = sqliteTable("workspace_sandbox_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  provider: text("provider").notNull().default("daytona"),
  providerConfigJson: text("provider_config_json"),
  // DEAD: superseded by workbenches.resourceProfile. No reader or writer
  // remains. Kept so drizzle stays in sync with the deployed DB; dropped in
  // the follow-up cleanup ticket alongside the legacy snapshot columns.
  defaultResourceProfile: text("default_resource_profile").notNull().default("small"),
  image: text("image").notNull().default(""),
  snapshot: text("snapshot"),
  smallSnapshot: text("small_snapshot"),
  mediumSnapshot: text("medium_snapshot"),
  daytonaApiKeySecretName: text("daytona_api_key_secret_name").notNull().default("sandbox:daytona"),
  daytonaApiUrl: text("daytona_api_url"),
  daytonaTarget: text("daytona_target"),
  idleTimeoutMs: integer("idle_timeout_ms").notNull().default(900000),
  recoveryTtlMs: integer("recovery_ttl_ms").notNull().default(86400000),
  maxProcessRuntimeMs: integer("max_process_runtime_ms").notNull().default(600000),
  limitsJson: text("limits_json").notNull().default("{}"),
  networkRestrictionEnabled: integer("network_restriction_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  networkDomainAllowlist: text("network_domain_allowlist").notNull().default(""),
  envVarsJson: text("env_vars_json"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * Cross-thread ledger of live containers. Cloudflare exposes no way to
 * enumerate containers by tenant, and per-thread compute state lives inside
 * each thread's DO SQLite, so this is the only place a workspace's concurrent
 * container count is visible.
 *
 * The DO's `compute_state` stays authoritative; this is a claim about reality
 * that is deliberately built to tolerate being stale — `expires_at` bounds how
 * long a leaked row can consume a slot.
 */
export const activeContainers = sqliteTable(
  "active_containers",
  {
    threadId: text("thread_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    profile: text("profile").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_active_containers_ws").on(table.workspaceId, table.expiresAt),
  }),
);

export type ActiveContainerRow = typeof activeContainers.$inferSelect;

export const workspacePrivacySettings = sqliteTable("workspace_privacy_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  telemetryEnabled: integer("telemetry_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const agentMemories = sqliteTable(
  "agent_memories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    content: text("content").notNull(),
    title: text("title"),
    kind: text("kind", { enum: ["fact", "preference", "workflow", "project"] })
      .notNull()
      .default("fact"),
    sourceThreadId: text("source_thread_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (table) => ({
    byAgent: index("idx_agent_memories_agent").on(
      table.workspaceId,
      table.agentId,
      table.archivedAt,
      table.updatedAt,
    ),
    bySourceThread: index("idx_agent_memories_source_thread").on(table.sourceThreadId),
  }),
);

export const agentSkills = sqliteTable(
  "agent_skills",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    networkDomains: text("network_domains"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (table) => ({
    byAgent: index("idx_agent_skills_agent").on(table.workspaceId, table.agentId, table.archivedAt),
    byName: index("idx_agent_skills_name").on(table.workspaceId, table.agentId, table.name),
    activeNameUnique: uniqueIndex("idx_agent_skills_active_name_unique")
      .on(table.workspaceId, table.agentId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
  }),
);

export const agentSkillResources = sqliteTable(
  "agent_skill_resources",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => agentSkills.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind", { enum: ["script", "reference", "asset", "file"] }).notNull(),
    encoding: text("encoding", { enum: ["text", "base64"] }).notNull(),
    mimeType: text("mime_type"),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    bySkill: index("idx_agent_skill_resources_skill").on(table.skillId),
    pathUnique: uniqueIndex("idx_agent_skill_resources_skill_path").on(table.skillId, table.path),
  }),
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    customInstructions: text("custom_instructions").notNull().default(""),
    defaultWorkbenchId: text("default_workbench_id").references(() => workbenches.id),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspaceArchived: index("idx_projects_workspace_archived").on(
      table.workspaceId,
      table.archivedAt,
    ),
  }),
);

export const githubAppInstallations = sqliteTable(
  "github_app_installations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(), // "org" | "user"
    repositorySelection: text("repository_selection").notNull(), // "all" | "selected"
    connectedByUserId: text("connected_by_user_id").notNull(),
    status: text("status").notNull().default("active"), // "active" | "disconnected" | "suspended"
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_github_app_installations_workspace").on(table.workspaceId),
    byWorkspaceInstallation: uniqueIndex("uidx_github_app_installations_ws_installation").on(
      table.workspaceId,
      table.installationId,
    ),
  }),
);

export const workbenches = sqliteTable(
  "workbenches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    setupScript: text("setup_script").notNull().default(""),
    resourceProfile: text("resource_profile").notNull().default("small"),
    sandboxEnvVarsJson: text("sandbox_env_vars_json").notNull().default("{}"),
    // Additional host allowlist domains, comma/newline separated. Applied
    // additively on top of the workspace allowlist, and only when the workspace
    // has network restriction enabled (the workspace toggle is the master
    // switch). Empty = no additions.
    sandboxNetworkDomainAllowlist: text("sandbox_network_domain_allowlist").notNull().default(""),
    // Secret NAMES live in `workbench_secret_names` (strongly-consistent D1),
    // not KV — a just-added secret must show in the UI immediately, and KV
    // `list` is eventually consistent (up to ~60s). This flag records whether
    // that D1 index has been seeded from the pre-existing KV secrets yet; until
    // it has, the name read falls back to the KV list once and backfills.
    secretNamesBackfilled: integer("secret_names_backfilled", { mode: "boolean" })
      .notNull()
      .default(false),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspaceArchived: index("idx_workbenches_workspace_archived").on(
      table.workspaceId,
      table.archivedAt,
    ),
  }),
);

/**
 * Strongly-consistent index of a workbench's secret NAMES (values stay
 * encrypted in KV). D1 is the source of truth the UI reads, so a freshly added
 * secret appears at once and a deleted one disappears at once — neither waits on
 * KV `list` propagation. One row per (workbench, name).
 */
export const workbenchSecretNames = sqliteTable(
  "workbench_secret_names",
  {
    workbenchId: text("workbench_id")
      .notNull()
      .references(() => workbenches.id),
    name: text("name").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workbenchId, table.name] }),
  }),
);

export const workbenchRepositories = sqliteTable(
  "workbench_repositories",
  {
    id: text("id").primaryKey(),
    workbenchId: text("workbench_id")
      .notNull()
      .references(() => workbenches.id),
    source: text("source", { enum: ["github", "url"] }).notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    githubRepoId: integer("github_repo_id"),
    sourceInstallationId: text("source_installation_id").references(
      () => githubAppInstallations.id,
    ),
    accessStatus: text("access_status").notNull().default("ok"),
    checkoutPathName: text("checkout_path_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    rootDirectory: text("root_directory").notNull().default(""),
    setupCommand: text("setup_command").notNull().default(""),
    packageManager: text("package_manager").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byWorkbench: index("idx_workbench_repositories_workbench").on(table.workbenchId),
  }),
);

export const threadWorkbenchSnapshots = sqliteTable("thread_workbench_snapshots", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threadIndex.id),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  workbenchId: text("workbench_id"),
  name: text("name").notNull(),
  setupScript: text("setup_script").notNull().default(""),
  // Nullable: snapshots written before workbenches carried a profile have no
  // honest value here, and fall through to DEFAULT_COMPUTE_RESOURCE_PROFILE.
  resourceProfile: text("resource_profile"),
  createdAt: integer("created_at").notNull(),
});

export const threadRepositorySnapshots = sqliteTable(
  "thread_repository_snapshots",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threadIndex.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: text("project_id").references(() => projects.id),
    workbenchId: text("workbench_id"),
    name: text("name").notNull(),
    url: text("url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    checkoutPathName: text("checkout_path_name").notNull(),
    rootDirectory: text("root_directory").notNull().default(""),
    setupCommand: text("setup_command").notNull().default(""),
    packageManager: text("package_manager").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byThread: index("idx_thread_repository_snapshots_thread").on(table.threadId),
    byWorkspace: index("idx_thread_repository_snapshots_workspace").on(table.workspaceId),
  }),
);

export const threadIndex = sqliteTable(
  "thread_index",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    projectId: text("project_id"),
    workbenchId: text("workbench_id").references(() => workbenches.id),
    // Set while a workbench switch waits for the agent to save its work; the
    // snapshot still holds the OLD workbench until commit.
    workbenchSwitchPendingAt: integer("workbench_switch_pending_at"),
    modelProvider: text("model_provider"),
    model: text("model"),
    modelInputModalities: text("model_input_modalities"),
    showReasoning: integer("show_reasoning", { mode: "boolean" }),
    /** Snapshotted from the agent at thread creation; NULL inherits. */
    reasoningEffort: text("reasoning_effort"),
    /** NULL = unknown, never "cannot reason". See agents.modelSupportsReasoning. */
    modelSupportsReasoning: integer("model_supports_reasoning", { mode: "boolean" }),
    kind: text("kind", { enum: ["regular", "feedback"] })
      .notNull()
      .default("regular"),
    title: text("title").notNull(),
    titleSet: integer("title_set", { mode: "boolean" }).notNull().default(false),
    runtime: text("runtime", { enum: ["legacy", "think"] })
      .notNull()
      .default("legacy"),
    activityStatus: text("activity_status", {
      enum: ["idle", "running", "attention_required", "failed"],
    })
      .notNull()
      .default("idle"),
    currentTurnStartedAt: integer("current_turn_started_at"),
    attentionRequiredAt: integer("attention_required_at"),
    source: text("source", { enum: ["manual", "automaton"] }).notNull(),
    automatonId: text("automaton_id"),
    automatonRunId: text("automaton_run_id"),
    lastEventId: text("last_event_id"),
    lastMessagePreview: text("last_message_preview").notNull().default(""),
    unreadOutcome: text("unread_outcome", { enum: ["completed", "failed"] }),
    unreadOutcomeAt: integer("unread_outcome_at"),
    outcomeDismissedAt: integer("outcome_dismissed_at"),
    /**
     * User-side "not in my recent list right now". The thread is hidden from the
     * sidebar rail while `recentDismissedAt >= updatedAt`, so ordinary activity
     * bumps `updatedAt` past the stamp and brings it back with no un-dismiss
     * job. That makes one rule load-bearing: the write that sets this must NOT
     * touch `updatedAt`, or the dismissal satisfies its own expiry immediately
     * and silently does nothing. It never hides the thread from All chats,
     * search, or the projects panel — unlike `outcomeDismissedAt`, which is
     * enforced in the list query itself.
     */
    recentDismissedAt: integer("recent_dismissed_at"),
    lastSeenAt: integer("last_seen_at"),
    archivedAt: integer("archived_at"),
    /**
     * The `updatedAt` this thread had when the archive last REFUSED it (empty
     * transcript). Stores the observed activity stamp, not a wall clock, so the
     * comparison is against the same monotonic clock the cutoff uses: the thread
     * becomes eligible again only once `updatedAt` moves past it. Without this a
     * permanently-unarchivable thread (an empty one) sits at the head of the
     * oldest-first cron batch forever and starves every thread behind it.
     */
    archiveSkippedUpdatedAt: integer("archive_skipped_updated_at"),
    /**
     * The real, provider-reported context size of the last turn, and the window
     * it ran against. NULL means "not tracked" (a pre-feature thread, or one
     * that has never run a turn) — which is NOT the same as zero.
     */
    lastContextTokens: integer("last_context_tokens"),
    lastContextWindow: integer("last_context_window"),
    /**
     * The compaction trigger that turn actually ran with (`ContextBudget
     * .compactAfterTokens`). Persisted rather than re-derived client-side: the
     * budget formula lives in `src/agent/context-budget.ts` and a copy of it in
     * the UI would drift. NULL means the client shows no warning threshold.
     */
    lastCompactAfterTokens: integer("last_compact_after_tokens"),
    searchIndexedThrough: integer("search_indexed_through"),
    /**
     * Consecutive scheduled-repair failures. Repair selects oldest-first, so a
     * thread that throws every time would sit at the head of the queue and
     * consume a batch slot forever. Ordering on this count rotates a failing
     * thread behind its healthy peers; a successful reconcile clears it.
     */
    searchRepairAttempts: integer("search_repair_attempts"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspaceUpdated: index("idx_thread_index_workspace_updated").on(
      table.workspaceId,
      table.updatedAt,
    ),
    byWorkspaceProjectUpdated: index("idx_thread_index_workspace_project_updated").on(
      table.workspaceId,
      table.projectId,
      table.updatedAt,
    ),
    byWorkspaceArchived: index("idx_thread_index_workspace_archived").on(
      table.workspaceId,
      table.archivedAt,
    ),
    byAutomaton: index("idx_thread_index_automaton").on(table.workspaceId, table.automatonId),
  }),
);

export const threadSearchMessages = sqliteTable(
  "thread_search_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    threadId: text("thread_id")
      .notNull()
      .references(() => threadIndex.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    createdAt: integer("created_at"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceHash: text("source_hash").notNull(),
    indexedRevision: integer("indexed_revision").notNull(),
  },
  (table) => ({
    byThreadMessage: uniqueIndex("idx_thread_search_messages_thread_message").on(
      table.threadId,
      table.messageId,
    ),
    byWorkspaceThread: index("idx_thread_search_messages_workspace_thread").on(
      table.workspaceId,
      table.threadId,
    ),
    byThreadCreated: index("idx_thread_search_messages_thread_created").on(
      table.threadId,
      table.createdAt,
    ),
  }),
);

/**
 * Cumulative, monotonic token ledger. One row per (thread, provider, model,
 * source) — bounded, not one row per turn. Writes are upsert-increments.
 *
 * Lives in D1, not DO SQLite, because archiving DESTROYS the DO
 * (`archive-thread.ts`) and these numbers must outlive it.
 *
 * Dimensions are stored separately rather than summed so that (a) the prompt-cache
 * story stays legible and (b) cost stays computable retroactively once a price
 * catalog exists.
 */
export const threadTokenUsage = sqliteTable(
  "thread_token_usage",
  {
    threadId: text("thread_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    source: text("source", {
      enum: ["chat", "compaction", "auto_name", "subagent", "feedback"],
    }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    /**
     * A SUBSET of `inputTokens`, not an addition to it (verified by live probe;
     * see CACHED_INPUT_ADDITIVE in `src/agent/usage-recorder.ts`). Cost is
     * therefore `(input - cached) * rate_in + cached * rate_cached` — summing
     * `input + cached` overstates.
     */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    // The upsert target. Also the reason row count stays bounded.
    unq: uniqueIndex("idx_thread_token_usage_key").on(
      table.threadId,
      table.provider,
      table.model,
      table.source,
    ),
    byThread: index("idx_thread_token_usage_thread").on(table.threadId),
    // Groundwork for workspace/agent rollups.
    byWorkspace: index("idx_thread_token_usage_workspace").on(table.workspaceId),
  }),
);

export const feedbackThreads = sqliteTable("feedback_threads", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  threadId: text("thread_id")
    .notNull()
    .unique()
    .references(() => threadIndex.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const feedbackReports = sqliteTable(
  "feedback_reports",
  {
    id: text("id").primaryKey(),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    threadId: text("thread_id")
      .notNull()
      .references(() => threadIndex.id),
    interviewId: text("interview_id").notNull(),
    fromMessageId: text("from_message_id").notNull(),
    toMessageId: text("to_message_id").notNull(),
    category: text("category", { enum: ["bug", "feature", "general"] }).notNull(),
    title: text("title").notNull(),
    narrative: text("narrative").notNull(),
    reproductionStepsJson: text("reproduction_steps_json").notNull(),
    expectedBehavior: text("expected_behavior"),
    actualBehavior: text("actual_behavior"),
    frequency: text("frequency"),
    impact: text("impact"),
    diagnosticsJson: text("diagnostics_json").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    submittedAt: integer("submitted_at").notNull(),
  },
  (table) => ({
    bySubmitted: index("idx_feedback_reports_submitted").on(table.submittedAt, table.id),
    byReporter: index("idx_feedback_reports_reporter").on(table.reporterUserId, table.submittedAt),
    oneInterview: uniqueIndex("idx_feedback_reports_interview").on(
      table.threadId,
      table.interviewId,
    ),
  }),
);

export const feedbackReportAttachments = sqliteTable(
  "feedback_report_attachments",
  {
    reportId: text("report_id")
      .notNull()
      .references(() => feedbackReports.id),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.reportId, table.attachmentId] }),
    ordered: uniqueIndex("idx_feedback_report_attachment_order").on(table.reportId, table.ordinal),
  }),
);

export const feedbackAdminReads = sqliteTable(
  "feedback_admin_reads",
  {
    reportId: text("report_id")
      .notNull()
      .references(() => feedbackReports.id),
    adminUserId: text("admin_user_id")
      .notNull()
      .references(() => users.id),
    seenAt: integer("seen_at").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.reportId, table.adminUserId] }) }),
);

export const archivedMessage = sqliteTable(
  "archived_message",
  {
    threadId: text("thread_id").notNull(),
    seq: integer("seq").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.threadId, table.seq] }),
  }),
);

/**
 * The compaction overlays of an archived thread.
 *
 * `archived_message` holds the RAW transcript — every message, including the ones
 * a compaction summary hid. That is the record, and it is what archiving must not
 * destroy. The summaries are worth keeping too (they are the readable digest of a
 * long thread), but they are a VIEW: rendered at read time from these rows, never
 * stored as messages. Keeping them here lets an archived thread show either the
 * full history or the summarised one, without the summary ever masquerading as a
 * message again.
 */
export const archivedCompaction = sqliteTable(
  "archived_compaction",
  {
    threadId: text("thread_id").notNull(),
    seq: integer("seq").notNull(),
    compactionId: text("compaction_id").notNull(),
    fromMessageId: text("from_message_id").notNull(),
    toMessageId: text("to_message_id").notNull(),
    summary: text("summary").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.threadId, table.seq] }),
  }),
);

export const automata = sqliteTable(
  "automata",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    projectId: text("project_id"),
    workbenchId: text("workbench_id"),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /**
     * Model override. All three move together — null means the run inherits the
     * agent's model live at fire time, so changing the agent's model carries
     * every automaton that hasn't overridden it.
     */
    modelProvider: text("model_provider"),
    model: text("model"),
    modelInputModalities: text("model_input_modalities"),
    scheduleJson: text("schedule_json").notNull(),
    timezone: text("timezone").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    disabledReason: text("disabled_reason"),
    notifyMode: text("notify_mode", { enum: ["all", "failures_only"] })
      .notNull()
      .default("all"),
    nextDueAt: integer("next_due_at"),
    lastFiredAt: integer("last_fired_at"),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byDue: index("idx_automata_due").on(table.enabled, table.nextDueAt),
    byWorkspace: index("idx_automata_workspace").on(table.workspaceId, table.archivedAt),
  }),
);

export const automatonRuns = sqliteTable(
  "automaton_runs",
  {
    id: text("id").primaryKey(),
    automatonId: text("automaton_id")
      .notNull()
      .references(() => automata.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** Null for manual runs — they have no scheduled due instant. */
    dueAt: integer("due_at"),
    trigger: text("trigger", { enum: ["scheduled", "manual"] }).notNull(),
    threadId: text("thread_id"),
    status: text("status", {
      enum: ["queued", "running", "completed", "waiting_for_approval", "failed", "skipped"],
    }).notNull(),
    error: text("error"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byAutomaton: index("idx_automaton_runs_automaton").on(table.automatonId, table.createdAt),
    /**
     * The dedupe lease. A cron retry re-inserting the same due instant hits this
     * constraint and aborts. Partial on `trigger = 'scheduled'` so manual runs —
     * which are fully independent of dedupe — can never collide with each other.
     */
    oneRunPerDue: uniqueIndex("idx_automaton_runs_due")
      .on(table.automatonId, table.dueAt)
      .where(sql`${table.trigger} = 'scheduled'`),
  }),
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => ({
    byUser: index("idx_push_subscriptions_user").on(table.userId),
    endpointUnique: uniqueIndex("idx_push_subscriptions_endpoint").on(table.endpoint),
  }),
);

export const userNotificationSettings = sqliteTable("user_notification_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  browserPushEnabled: integer("browser_push_enabled", { mode: "boolean" }).notNull().default(false),
  // Push bodies carry the start of the assistant's reply. On by default; the
  // opt-out is for people whose lock screen is a public surface.
  pushPreviewEnabled: integer("push_preview_enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const userVoiceSettings = sqliteTable("user_voice_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  language: text("language").notNull().default("en"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const mcpToolPolicies = sqliteTable("mcp_tool_policies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  serverId: text("server_id")
    .notNull()
    .references(() => mcpServers.id),
  toolName: text("tool_name").notNull(),
  policy: text("policy", { enum: ["auto_allow", "approval_required", "deny"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const providerConfigs = sqliteTable("provider_configs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  provider: text("provider", {
    enum: [
      "openrouter",
      "openai",
      "anthropic",
      "openai-oauth",
      "workers-ai",
      "deepseek",
      "zai",
      "qwen",
      "opencode-go",
      "opencode-zen",
      "openai-compatible",
    ],
  }).notNull(),
  displayName: text("display_name").notNull(),
  secretName: text("secret_name").notNull(),
  configJson: text("config_json"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * The models a workspace has chosen to see in the model picker, per provider.
 *
 * Absent row = uncurated: every model in the provider's catalog is offered.
 * A present row is a curated inclusion list — models the provider adds later
 * stay hidden until enabled — and an empty array is the legitimate "curated to
 * nothing" state, not a missing row.
 *
 * Deliberately not folded into `provider_configs.config_json`: that table is
 * append-only, so a whitelist edit would rewrite endpoint history.
 */
export const providerModelWhitelists = sqliteTable(
  "provider_model_whitelists",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    provider: text("provider").notNull(),
    /** Full model records, not ids: the composer needs `inputModalities` to
     *  gate attachments, and carrying them here is what lets a curated picker
     *  render with no network call at all. */
    modelsJson: text("models_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.provider] }),
  }),
);

/** Cached provider model catalogs. Pure cache — safe to delete any row. */
/**
 * models.dev's capability metadata (reasoning and input modalities), pruned to
 * our providers. Global rather than per-workspace — it describes models, not a
 * workspace's configuration — so it deliberately has no workspaceId and a
 * single well-known row id.
 */
export const modelCapabilityCatalog = sqliteTable("model_capability_catalog", {
  id: text("id").primaryKey(),
  payloadJson: text("payload_json").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

export const providerModelCatalogs = sqliteTable(
  "provider_model_catalogs",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    provider: text("provider").notNull(),
    modelsJson: text("models_json").notNull(),
    source: text("source", { enum: ["live", "static"] }).notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.provider] }),
  }),
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    threadId: text("thread_id").notNull(),
    mimeType: text("mime_type").notNull(),
    filename: text("filename"),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    r2Key: text("r2_key").notNull(),
    status: text("status").notNull().default("pending"),
    extractedText: text("extracted_text"),
    extractedSource: text("extracted_source"),
    extractedAt: integer("extracted_at"),
    extractedError: text("extracted_error"),
    extractedAttempts: integer("extracted_attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byThread: index("idx_attachments_thread").on(table.threadId),
  }),
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    threadId: text("thread_id").notNull(),
    title: text("title").notNull(),
    entryPath: text("entry_path").notNull(),
    fileCount: integer("file_count").notNull(),
    byteSize: integer("byte_size").notNull(),
    r2Prefix: text("r2_prefix").notNull(),
    status: text("status").notNull().default("active"), // active | expired
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byThread: index("idx_artifacts_thread").on(table.threadId),
  }),
);
export type ArtifactRow = typeof artifacts.$inferSelect;

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type InviteStatus = Invite["status"];
/**
 * The KV table `RegistryKV` reads and writes — workspace secrets, already
 * AES-GCM ciphertext, plus a couple of `system/` markers the cron liveness
 * endpoint reads.
 *
 * Used on celld ONLY, where there is no KV binding and none is planned. On
 * Cloudflare the real `SECRETS_KV` binding serves this and the table stays
 * empty; it is defined here rather than created out-of-band so that ONE
 * drizzle-generated migration history covers both platforms, which is the
 * whole point of celld gaining D1 in v0.3.0.
 */
export const celldKv = sqliteTable("celld_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type WaitingListEntry = typeof waitingList.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type AgentConfig = typeof agents.$inferSelect;
export type WorkspaceSandboxSettingsRow = typeof workspaceSandboxSettings.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type AgentSkill = typeof agentSkills.$inferSelect;
export type AgentSkillResource = typeof agentSkillResources.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ThreadRepositorySnapshot = typeof threadRepositorySnapshots.$inferSelect;
export type GithubAppInstallationRow = typeof githubAppInstallations.$inferSelect;
export type Workbench = typeof workbenches.$inferSelect;
export type WorkbenchRepositoryRow = typeof workbenchRepositories.$inferSelect;
export type WorkbenchSecretNameRow = typeof workbenchSecretNames.$inferSelect;
export type ThreadWorkbenchSnapshot = typeof threadWorkbenchSnapshots.$inferSelect;
export type ThreadIndex = typeof threadIndex.$inferSelect;
export type FeedbackThread = typeof feedbackThreads.$inferSelect;
export type FeedbackReport = typeof feedbackReports.$inferSelect;
export type Automaton = typeof automata.$inferSelect;
export type AutomatonNotifyMode = Automaton["notifyMode"];
export type AutomatonRun = typeof automatonRuns.$inferSelect;
export type AutomatonRunStatus = AutomatonRun["status"];
export type AutomatonRunTrigger = AutomatonRun["trigger"];
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type UserNotificationSettings = typeof userNotificationSettings.$inferSelect;
export type CelldKvRow = typeof celldKv.$inferSelect;
