-- HAND-REWRITTEN. Turns N workbenches into N agents and moves every key that
-- pointed at a workbench onto the agent that replaced it.
--
-- Read the ORDER before changing anything here. Four rules constrain it:
--
--  1. `workbenches` is a PARENT (projects.default_workbench_id,
--     thread_index.workbench_id, agent_repositories.agent_id,
--     agent_secret_names.agent_id). D1 enforces FKs on the live connection and
--     its commit-time check rejects a batch that drops a referenced parent EVEN
--     WITH defer_foreign_keys=ON (and D1 IGNORES foreign_keys=OFF). So every
--     referrer is gone BEFORE `DROP TABLE workbenches`, which is last.
--  2. `thread_index` and `projects` are PARENTS themselves, so drizzle's
--     proposed `__new_` rebuild of either would fail on populated remote D1 for
--     the same reason. Both changes are done in place instead: their
--     workbench columns carry INLINE FKs, which ALTER TABLE ... DROP COLUMN
--     removes without touching the parent (0041's precedent, verified there
--     against a full export of the real remote DB).
--  3. `agent_repositories` and `agent_secret_names` ARE leaves (nothing
--     references either), so their rebuild is fine — and it is REQUIRED, because
--     repointing an FK is not an ALTER. Their rebuild is also what moves the
--     VALUES: the INSERT ... SELECT applies the workbench->agent mapping in the
--     same statement that installs the new FK. Values and key must not move
--     apart. A lag in either direction yields zero repositories for every
--     thread, nothing cloned, and no error anywhere — repository-preparation.ts
--     returns a summary with an EMPTY `skipped` list on that path, so even the
--     log.warn in agent-sandbox-do.ts never fires.
--  4. The three `__wb_*` helper tables exist only for the length of this
--     migration and are dropped at the end. They are NOT schema surfaces: they
--     never appear in schema.ts, registry.ts or reset.ts.
--
-- The KV secret re-key is NOT here — it is crypto, not SQL. It runs BEFORE this
-- migration, from scripts/rekey-workbench-secrets.mjs, which derives the SAME
-- workbench->agent mapping by the SAME rules (see `deriveAgentIdForWorkbench`
-- there and `__wb_agent_map` here; they must not drift). Its `--verify` mode is
-- what proves, after this migration, that every `agent_secret_names` row
-- decrypts under its new agent-scoped name.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint

-- 1. The two columns `agents` absorbs from `workbenches`.
-- `updated_at` takes a DEFAULT because SQLite cannot add a NOT NULL column
-- without one; the very next statement replaces the placeholder with the row's
-- real creation stamp. `secret_names_backfilled` stays FALSE on every row on
-- purpose — this migration is SQL and cannot see KV, so any secret already
-- written under the agent namespace by the sandbox settings surface has no D1
-- row yet; leaving the flag false makes the first read reconcile from KV once.
ALTER TABLE `agents` ADD `secret_names_backfilled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `agents` SET `updated_at` = `created_at`;--> statement-breakpoint

-- 2. The mapping, and a frozen copy of each workspace's legacy agent.
--
-- The legacy agent is the workspace's EARLIEST agent — the same row
-- `selectThreadTarget` has always resolved to. It is frozen into its own table
-- first so that step 3's INSERT never reads `agents` while writing it.
CREATE TABLE `__wb_legacy_agent` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`system_prompt` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`model_input_modalities` text NOT NULL,
	`show_reasoning` integer NOT NULL,
	`reasoning_effort` text NOT NULL,
	`model_supports_reasoning` integer,
	`sandbox_enabled` integer,
	`sandbox_idle_timeout_ms` integer,
	`sandbox_max_process_runtime_ms` integer,
	`sandbox_env_vars_json` text
);
--> statement-breakpoint
INSERT INTO `__wb_legacy_agent`
SELECT a.`workspace_id`, a.`id`, a.`system_prompt`, a.`provider`, a.`model`,
       a.`model_input_modalities`, a.`show_reasoning`, a.`reasoning_effort`,
       a.`model_supports_reasoning`, a.`sandbox_enabled`, a.`sandbox_idle_timeout_ms`,
       a.`sandbox_max_process_runtime_ms`, a.`sandbox_env_vars_json`
FROM `agents` a
WHERE a.`id` = (
	SELECT a2.`id` FROM `agents` a2
	WHERE a2.`workspace_id` = a.`workspace_id`
	ORDER BY a2.`created_at`, a2.`id` LIMIT 1
);--> statement-breakpoint

-- One workbench per workspace ADOPTS the legacy agent, keeping its id — the id
-- `agent_memories`, `skills`, `thread_index.agent_id` and `thread_token_usage`
-- all already reference. The pick is the workspace's earliest ACTIVE workbench
-- (archived ones sort last), which is also what a thread with NO workbench
-- assigned inherits, since such a thread keeps the legacy agent it already has.
-- Every other workbench becomes a NEW agent whose id is DERIVED from the
-- workbench id, not random: the KV re-key script has to reach the same answer
-- from outside this transaction.
CREATE TABLE `__wb_agent_map` (
	`workbench_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`is_primary` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__wb_agent_map` (`workbench_id`, `agent_id`, `is_primary`)
SELECT w.`id`, 'agt_' || w.`id`, 0 FROM `workbenches` w;--> statement-breakpoint
UPDATE `__wb_agent_map` SET
	`agent_id` = (
		SELECT la.`agent_id` FROM `__wb_legacy_agent` la
		JOIN `workbenches` w ON w.`id` = `__wb_agent_map`.`workbench_id`
		WHERE la.`workspace_id` = w.`workspace_id`
	),
	`is_primary` = 1
WHERE EXISTS (
	SELECT 1 FROM `__wb_legacy_agent` la
	JOIN `workbenches` w ON w.`id` = `__wb_agent_map`.`workbench_id`
	WHERE la.`workspace_id` = w.`workspace_id`
)
AND `workbench_id` = (
	SELECT w2.`id` FROM `workbenches` w2
	WHERE w2.`workspace_id` = (
		SELECT w3.`workspace_id` FROM `workbenches` w3 WHERE w3.`id` = `__wb_agent_map`.`workbench_id`
	)
	ORDER BY (w2.`archived_at` IS NOT NULL), w2.`created_at`, w2.`id` LIMIT 1
);--> statement-breakpoint

-- 3. Every non-adopted workbench becomes a new agent. Prompt, model and
-- reasoning settings are copied from the legacy agent (they were workspace-wide
-- before this merge, so every thread already ran under them); name, description
-- and the whole sandbox configuration come from the workbench.
--
-- `sandbox_env_vars_json` is the one MERGED field. Env-var precedence was
-- workspace < environment(workbench) < agent, so the legacy agent's vars beat
-- the workbench's for every thread today; json_patch's right side wins, which
-- reproduces exactly that. Dropping either side would silently change the
-- environment a sandbox comes up with.
--
-- `archived_at` is carried over ONLY for a workbench that no thread uses.
-- Archiving a workbench meant "stop offering this bundle for new threads", not
-- "the threads on it are finished" — and those threads stayed fully usable.
-- `thread_index.agent_id` is NOT NULL, so an archived agent here would turn
-- live threads into read-only history with nothing on screen to say why. An
-- archived workbench with no threads is pure clutter and stays archived.
INSERT INTO `agents` (
	`id`, `workspace_id`, `name`, `description`, `system_prompt`, `provider`, `model`,
	`model_input_modalities`, `show_reasoning`, `reasoning_effort`, `model_supports_reasoning`,
	`enabled`, `archived_at`, `sandbox_enabled`, `sandbox_idle_timeout_ms`,
	`sandbox_max_process_runtime_ms`, `sandbox_network_domain_allowlist`,
	`sandbox_env_vars_json`, `setup_script`, `resource_profile`,
	`secret_names_backfilled`, `created_at`, `updated_at`
)
SELECT m.`agent_id`, w.`workspace_id`, w.`name`, w.`description`, la.`system_prompt`,
       la.`provider`, la.`model`, la.`model_input_modalities`, la.`show_reasoning`,
       la.`reasoning_effort`, la.`model_supports_reasoning`,
       true,
       CASE WHEN w.`archived_at` IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM `thread_index` t WHERE t.`workbench_id` = w.`id`)
            THEN w.`archived_at` ELSE NULL END,
       la.`sandbox_enabled`, la.`sandbox_idle_timeout_ms`,
       la.`sandbox_max_process_runtime_ms`, w.`sandbox_network_domain_allowlist`,
       json_patch(
		COALESCE(NULLIF(w.`sandbox_env_vars_json`, ''), '{}'),
		COALESCE(NULLIF(la.`sandbox_env_vars_json`, ''), '{}')
       ),
       w.`setup_script`, w.`resource_profile`, false, w.`created_at`, w.`updated_at`
FROM `__wb_agent_map` m
JOIN `workbenches` w ON w.`id` = m.`workbench_id`
JOIN `__wb_legacy_agent` la ON la.`workspace_id` = w.`workspace_id`
WHERE m.`is_primary` = 0;--> statement-breakpoint

-- 4. The adopting agent takes its workbench's sandbox configuration. Its name,
-- description, prompt and model are its own and are NOT overwritten — the
-- workbench's name described a bundle of repositories, not an agent.
UPDATE `agents` SET
	`setup_script` = (SELECT w.`setup_script` FROM `workbenches` w JOIN `__wb_agent_map` m ON m.`workbench_id` = w.`id` WHERE m.`agent_id` = `agents`.`id` AND m.`is_primary` = 1),
	`resource_profile` = (SELECT w.`resource_profile` FROM `workbenches` w JOIN `__wb_agent_map` m ON m.`workbench_id` = w.`id` WHERE m.`agent_id` = `agents`.`id` AND m.`is_primary` = 1),
	`sandbox_network_domain_allowlist` = (SELECT w.`sandbox_network_domain_allowlist` FROM `workbenches` w JOIN `__wb_agent_map` m ON m.`workbench_id` = w.`id` WHERE m.`agent_id` = `agents`.`id` AND m.`is_primary` = 1),
	`sandbox_env_vars_json` = (
		SELECT json_patch(
			COALESCE(NULLIF(w.`sandbox_env_vars_json`, ''), '{}'),
			COALESCE(NULLIF(`agents`.`sandbox_env_vars_json`, ''), '{}')
		)
		FROM `workbenches` w JOIN `__wb_agent_map` m ON m.`workbench_id` = w.`id`
		WHERE m.`agent_id` = `agents`.`id` AND m.`is_primary` = 1
	)
WHERE EXISTS (SELECT 1 FROM `__wb_agent_map` m WHERE m.`agent_id` = `agents`.`id` AND m.`is_primary` = 1);--> statement-breakpoint

-- 5. Memories are COPIED to each new agent. They were workspace-wide in
-- practice (one agent per workspace), so an agent that started empty would be a
-- silent loss of everything the assistant had learned. Skills are NOT copied —
-- they are promoted to the workspace library in step 6.
INSERT INTO `agent_memories` (
	`id`, `workspace_id`, `agent_id`, `content`, `title`, `kind`, `source_thread_id`,
	`created_at`, `updated_at`, `archived_at`
)
SELECT m.`agent_id` || ':' || am.`id`, am.`workspace_id`, m.`agent_id`, am.`content`,
       am.`title`, am.`kind`, am.`source_thread_id`, am.`created_at`, am.`updated_at`,
       am.`archived_at`
FROM `__wb_agent_map` m
JOIN `workbenches` w ON w.`id` = m.`workbench_id`
JOIN `__wb_legacy_agent` la ON la.`workspace_id` = w.`workspace_id`
JOIN `agent_memories` am ON am.`agent_id` = la.`agent_id`
WHERE m.`is_primary` = 0;--> statement-breakpoint

-- 6. Skills are PROMOTED to the workspace library (agent_id = NULL) so that
-- every agent this migration created has them, with no copies to keep in sync.
--
-- Task 2's partial unique index REJECTS a second library skill of the same name,
-- which is right: silently picking a winner would lose a skill body forever. So
-- exactly ONE owner's copy is promoted per (workspace, name) — the oldest by
-- created_at, tie-broken by id — and every same-named sibling stays
-- agent-private, where the shadowing rule keeps it working identically for its
-- own agent. The chosen set is materialised FIRST: evaluating the pick inside
-- the UPDATE would re-evaluate it against rows the same UPDATE had already
-- promoted, and promote the runners-up too.
--
-- Archived skills are left alone. They are outside both partial indexes and
-- their owning agent still exists.
CREATE TABLE `__wb_skill_promote` (`id` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO `__wb_skill_promote` (`id`)
SELECT s.`id` FROM `skills` s
WHERE s.`agent_id` IS NOT NULL
  AND s.`archived_at` IS NULL
  AND s.`id` = (
	SELECT s2.`id` FROM `skills` s2
	WHERE s2.`workspace_id` = s.`workspace_id` AND s2.`name` = s.`name`
	  AND s2.`agent_id` IS NOT NULL AND s2.`archived_at` IS NULL
	ORDER BY s2.`created_at`, s2.`id` LIMIT 1
  )
  AND NOT EXISTS (
	SELECT 1 FROM `skills` s3
	WHERE s3.`workspace_id` = s.`workspace_id` AND s3.`name` = s.`name`
	  AND s3.`agent_id` IS NULL AND s3.`archived_at` IS NULL
  );--> statement-breakpoint
UPDATE `skills` SET `agent_id` = NULL WHERE `id` IN (SELECT `id` FROM `__wb_skill_promote`);--> statement-breakpoint

-- 7. Threads follow their workbench to the agent that replaced it. A thread with
-- NO workbench assigned keeps the agent it already has, which is the legacy
-- agent — the same one the earliest workbench adopted.
UPDATE `thread_index` SET `agent_id` = COALESCE(
	(SELECT m.`agent_id` FROM `__wb_agent_map` m WHERE m.`workbench_id` = `thread_index`.`workbench_id`),
	`agent_id`
);--> statement-breakpoint
ALTER TABLE `thread_index` DROP COLUMN `workbench_id`;--> statement-breakpoint

-- 8. A project's default workbench becomes its default agent. ADD before DROP,
-- both in place: `default_workbench_id` carries an INLINE FK, so DROP COLUMN
-- removes it without rebuilding this parent table, and SQLite permits ADD COLUMN
-- with a REFERENCES clause as long as the default is NULL.
ALTER TABLE `projects` ADD `default_agent_id` text REFERENCES `agents`(`id`);--> statement-breakpoint
UPDATE `projects` SET `default_agent_id` = (
	SELECT m.`agent_id` FROM `__wb_agent_map` m WHERE m.`workbench_id` = `projects`.`default_workbench_id`
);--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `default_workbench_id`;--> statement-breakpoint

-- 9. An automaton's workbench override becomes an agent override. `agent_id` is
-- already the column that names what a run executes as, so the override folds
-- into it and the separate column goes.
--
-- The middle COALESCE arm matters. An automaton with NO override used to
-- inherit its project's default workbench AT FIRE TIME. `agent_id` is NOT NULL,
-- so there is no longer a value that means "inherit", and the inheritance is
-- resolved here instead — otherwise every such automaton would silently move
-- onto the legacy agent's repositories on its next run.
UPDATE `automata` SET `agent_id` = COALESCE(
	(SELECT m.`agent_id` FROM `__wb_agent_map` m WHERE m.`workbench_id` = `automata`.`workbench_id`),
	(SELECT p.`default_agent_id` FROM `projects` p WHERE p.`id` = `automata`.`project_id`),
	`agent_id`
);--> statement-breakpoint
ALTER TABLE `automata` DROP COLUMN `workbench_id`;--> statement-breakpoint

-- 10. The two leaves. Their `agent_id` has held a WORKBENCH id since the Task 1
-- rename; the INSERT ... SELECT below rewrites the values and the surrounding
-- rebuild repoints the FK, in one step. COALESCE rather than a filtering join
-- on purpose: a row whose workbench has no mapping is a real inconsistency and
-- must fail the FK loudly, not vanish.
CREATE TABLE `__new_agent_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`github_repo_id` integer,
	`source_installation_id` text,
	`access_status` text DEFAULT 'ok' NOT NULL,
	`checkout_path_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`root_directory` text DEFAULT '' NOT NULL,
	`setup_command` text DEFAULT '' NOT NULL,
	`package_manager` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_installation_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_repositories`("id", "agent_id", "source", "name", "url", "github_repo_id", "source_installation_id", "access_status", "checkout_path_name", "default_branch", "root_directory", "setup_command", "package_manager", "created_at") SELECT r."id", COALESCE(m."agent_id", r."agent_id"), r."source", r."name", r."url", r."github_repo_id", r."source_installation_id", r."access_status", r."checkout_path_name", r."default_branch", r."root_directory", r."setup_command", r."package_manager", r."created_at" FROM `agent_repositories` r LEFT JOIN `__wb_agent_map` m ON m.`workbench_id` = r.`agent_id`;--> statement-breakpoint
DROP TABLE `agent_repositories`;--> statement-breakpoint
ALTER TABLE `__new_agent_repositories` RENAME TO `agent_repositories`;--> statement-breakpoint
CREATE INDEX `idx_agent_repositories_agent` ON `agent_repositories` (`agent_id`);--> statement-breakpoint
CREATE TABLE `__new_agent_secret_names` (
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `name`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_secret_names`("agent_id", "name", "updated_at") SELECT COALESCE(m."agent_id", s."agent_id"), s."name", s."updated_at" FROM `agent_secret_names` s LEFT JOIN `__wb_agent_map` m ON m.`workbench_id` = s.`agent_id`;--> statement-breakpoint
DROP TABLE `agent_secret_names`;--> statement-breakpoint
ALTER TABLE `__new_agent_secret_names` RENAME TO `agent_secret_names`;--> statement-breakpoint

-- 11. Last, once nothing references it.
DROP TABLE `workbenches`;--> statement-breakpoint
DROP TABLE `__wb_skill_promote`;--> statement-breakpoint
DROP TABLE `__wb_agent_map`;--> statement-breakpoint
DROP TABLE `__wb_legacy_agent`;
