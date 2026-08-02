CREATE TABLE `thread_search_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_hash` text NOT NULL,
	`indexed_revision` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_index`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_thread_search_messages_thread_message` ON `thread_search_messages` (`thread_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_search_messages_workspace_thread` ON `thread_search_messages` (`workspace_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_thread_search_messages_thread_created` ON `thread_search_messages` (`thread_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `thread_index` ADD `search_indexed_through` integer;