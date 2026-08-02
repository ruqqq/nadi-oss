ALTER TABLE `thread_index` ADD `archived_at` integer;--> statement-breakpoint
CREATE INDEX `idx_thread_index_workspace_archived` ON `thread_index` (`workspace_id`,`archived_at`);