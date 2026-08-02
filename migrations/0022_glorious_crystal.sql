CREATE TABLE `project_repository_assignments` (
	`project_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `repository_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `workspace_repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`custom_instructions` text DEFAULT '' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_projects_workspace_archived` ON `projects` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `thread_repository_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
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
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_thread_repository_snapshots_thread` ON `thread_repository_snapshots` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_repository_snapshots_workspace` ON `thread_repository_snapshots` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`checkout_path_name` text NOT NULL,
	`root_directory` text DEFAULT '' NOT NULL,
	`setup_command` text DEFAULT '' NOT NULL,
	`package_manager` text DEFAULT '' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_repositories_workspace_archived` ON `workspace_repositories` (`workspace_id`,`archived_at`);--> statement-breakpoint
ALTER TABLE `thread_index` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `idx_thread_index_workspace_project_updated` ON `thread_index` (`workspace_id`,`project_id`,`updated_at`);