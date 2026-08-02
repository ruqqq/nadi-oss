CREATE TABLE `active_containers` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`profile` text NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_active_containers_ws` ON `active_containers` (`workspace_id`,`expires_at`);