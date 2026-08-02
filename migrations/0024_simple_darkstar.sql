CREATE TABLE `workspace_privacy_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`telemetry_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
