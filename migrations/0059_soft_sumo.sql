CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`title` text NOT NULL,
	`entry_path` text NOT NULL,
	`file_count` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`r2_prefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_thread` ON `artifacts` (`thread_id`);