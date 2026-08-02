CREATE TABLE `thread_token_usage` (
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`source` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_thread_token_usage_key` ON `thread_token_usage` (`thread_id`,`provider`,`model`,`source`);--> statement-breakpoint
CREATE INDEX `idx_thread_token_usage_thread` ON `thread_token_usage` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_token_usage_workspace` ON `thread_token_usage` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `thread_index` ADD `last_context_tokens` integer;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `last_context_window` integer;