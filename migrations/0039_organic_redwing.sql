CREATE TABLE `environments` (
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
CREATE INDEX `idx_environments_workspace_archived` ON `environments` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `environment_repositories` (
	`environment_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`environment_id`, `repository_id`),
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `workspace_repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `thread_environment_snapshots` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`environment_id` text,
	`name` text NOT NULL,
	`setup_script` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_index`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `__new_thread_repository_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`environment_id` text,
	`workspace_repository_id` text,
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
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_thread_repository_snapshots`("id", "thread_id", "workspace_id", "project_id", "workspace_repository_id", "name", "url", "default_branch", "checkout_path_name", "root_directory", "setup_command", "package_manager", "created_at") SELECT "id", "thread_id", "workspace_id", "project_id", "workspace_repository_id", "name", "url", "default_branch", "checkout_path_name", "root_directory", "setup_command", "package_manager", "created_at" FROM `thread_repository_snapshots`;--> statement-breakpoint
DROP TABLE `thread_repository_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_thread_repository_snapshots` RENAME TO `thread_repository_snapshots`;--> statement-breakpoint
CREATE INDEX `idx_thread_repository_snapshots_thread` ON `thread_repository_snapshots` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_repository_snapshots_workspace` ON `thread_repository_snapshots` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `default_environment_id` text REFERENCES environments(id);--> statement-breakpoint
ALTER TABLE `thread_index` ADD `environment_id` text REFERENCES environments(id);--> statement-breakpoint
ALTER TABLE `workspace_repositories` ADD `source_installation_id` text REFERENCES github_app_installations(id);--> statement-breakpoint
ALTER TABLE `workspace_repositories` ADD `github_repo_id` integer;--> statement-breakpoint
ALTER TABLE `workspace_repositories` ADD `access_status` text DEFAULT 'ok' NOT NULL;
