CREATE TABLE `feedback_admin_reads` (
	`report_id` text NOT NULL,
	`admin_user_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`report_id`, `admin_user_id`),
	FOREIGN KEY (`report_id`) REFERENCES `feedback_reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`admin_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `feedback_report_attachments` (
	`report_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	PRIMARY KEY(`report_id`, `attachment_id`),
	FOREIGN KEY (`report_id`) REFERENCES `feedback_reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feedback_report_attachment_order` ON `feedback_report_attachments` (`report_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `feedback_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`interview_id` text NOT NULL,
	`from_message_id` text NOT NULL,
	`to_message_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`narrative` text NOT NULL,
	`reproduction_steps_json` text NOT NULL,
	`expected_behavior` text,
	`actual_behavior` text,
	`frequency` text,
	`impact` text,
	`diagnostics_json` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_index`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_reports_idempotency_key_unique` ON `feedback_reports` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_feedback_reports_submitted` ON `feedback_reports` (`submitted_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_reports_reporter` ON `feedback_reports` (`reporter_user_id`,`submitted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feedback_reports_interview` ON `feedback_reports` (`thread_id`,`interview_id`);--> statement-breakpoint
CREATE TABLE `feedback_threads` (
	`user_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_index`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_threads_thread_id_unique` ON `feedback_threads` (`thread_id`);--> statement-breakpoint
ALTER TABLE `thread_index` ADD `kind` text DEFAULT 'regular' NOT NULL;