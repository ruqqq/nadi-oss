CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_push_subscriptions_user` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `user_notification_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`browser_push_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `thread_index` ADD `activity_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `current_turn_started_at` integer;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `attention_required_at` integer;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `unread_outcome` text;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `unread_outcome_at` integer;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `last_seen_at` integer;