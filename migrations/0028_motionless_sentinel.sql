ALTER TABLE `automata` ADD `notify_mode` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `outcome_dismissed_at` integer;