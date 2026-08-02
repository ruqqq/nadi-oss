CREATE TABLE `workspace_sandbox_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`provider` text DEFAULT 'daytona' NOT NULL,
	`image` text DEFAULT '' NOT NULL,
	`daytona_api_key_secret_name` text DEFAULT 'sandbox:daytona' NOT NULL,
	`daytona_api_url` text,
	`daytona_target` text,
	`idle_timeout_ms` integer DEFAULT 900000 NOT NULL,
	`max_process_runtime_ms` integer DEFAULT 600000 NOT NULL,
	`limits_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `sandbox_enabled` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `sandbox_image` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `sandbox_idle_timeout_ms` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `sandbox_max_process_runtime_ms` integer;
