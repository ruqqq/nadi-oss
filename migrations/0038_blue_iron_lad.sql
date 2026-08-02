CREATE TABLE `github_app_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_github_app_installations_workspace` ON `github_app_installations` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_github_app_installations_ws_installation` ON `github_app_installations` (`workspace_id`,`installation_id`);