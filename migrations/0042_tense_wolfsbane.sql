CREATE TABLE `thread_workbench_snapshots` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workbench_id` text,
	`name` text NOT NULL,
	`setup_script` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_index`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workbench_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`workbench_id` text NOT NULL,
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
	FOREIGN KEY (`workbench_id`) REFERENCES `workbenches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_installation_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workbench_repositories_workbench` ON `workbench_repositories` (`workbench_id`);--> statement-breakpoint
CREATE TABLE `workbenches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`setup_script` text DEFAULT '' NOT NULL,
	`sandbox_env_vars_json` text DEFAULT '{}' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workbenches_workspace_archived` ON `workbenches` (`workspace_id`,`archived_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `default_workbench_id` text REFERENCES workbenches(id);--> statement-breakpoint
ALTER TABLE `thread_index` ADD `workbench_id` text REFERENCES workbenches(id);--> statement-breakpoint
ALTER TABLE `thread_repository_snapshots` ADD `workbench_id` text;