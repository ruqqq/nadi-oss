-- HAND-REWRITTEN for D1 compatibility (see task notes / final-fix-report.md).
--
-- drizzle generated a `__new_`-table rebuild for `projects`, `thread_index`, and
-- `thread_repository_snapshots` to drop their environment/workspace_repository
-- columns. That approach CANNOT apply on a populated remote D1:
--   * D1 ignores `PRAGMA foreign_keys=OFF` and enforces FKs on the live
--     connection, so `DROP TABLE projects` / `DROP TABLE thread_index` fail —
--     those tables are referenced by many others (messages, events, snapshots…),
--     and you cannot drop a referenced parent.
--   * Adding `PRAGMA defer_foreign_keys=ON` (which D1 DOES honor) got past the
--     drops, but D1's commit-time integrity check still rejected the batch.
--
-- Fix, verified by replaying against a full export of the real remote DB
-- (foreign_key_check = 0 violations, all rows preserved):
--   * `projects.default_environment_id` and `thread_index.environment_id` are
--     inline-FK columns → drop them in place with ALTER TABLE ... DROP COLUMN
--     (no parent-table drop, so nothing to block the FK).
--   * `thread_repository_snapshots` carries a TABLE-LEVEL FK on `environment_id`
--     that DROP COLUMN cannot remove, so it still needs drizzle's `__new_`
--     rebuild — but it is a leaf table (nothing references it), so dropping and
--     renaming it succeeds. Its rebuild block below is drizzle's verbatim.
--   * The four standalone env tables are dropped last, child-first.
-- `defer_foreign_keys=ON` is kept as a belt-and-suspenders for the drops.
-- Produces the identical final schema drizzle intended (schema.ts is the source
-- of truth). Verified via a clean local `pnpm run db:migrate:local` through 0042.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `default_environment_id`;--> statement-breakpoint
ALTER TABLE `thread_index` DROP COLUMN `environment_id`;--> statement-breakpoint
CREATE TABLE `__new_thread_repository_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`default_branch` text NOT NULL,
	`checkout_path_name` text NOT NULL,
	`root_directory` text DEFAULT '' NOT NULL,
	`setup_command` text DEFAULT '' NOT NULL,
	`package_manager` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_index`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_thread_repository_snapshots`("id", "thread_id", "workspace_id", "project_id", "name", "url", "default_branch", "checkout_path_name", "root_directory", "setup_command", "package_manager", "created_at") SELECT "id", "thread_id", "workspace_id", "project_id", "name", "url", "default_branch", "checkout_path_name", "root_directory", "setup_command", "package_manager", "created_at" FROM `thread_repository_snapshots`;--> statement-breakpoint
DROP TABLE `thread_repository_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_thread_repository_snapshots` RENAME TO `thread_repository_snapshots`;--> statement-breakpoint
CREATE INDEX `idx_thread_repository_snapshots_thread` ON `thread_repository_snapshots` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_repository_snapshots_workspace` ON `thread_repository_snapshots` (`workspace_id`);--> statement-breakpoint
DROP TABLE `environment_repositories`;--> statement-breakpoint
DROP TABLE `thread_environment_snapshots`;--> statement-breakpoint
DROP TABLE `workspace_repositories`;--> statement-breakpoint
DROP TABLE `environments`;
