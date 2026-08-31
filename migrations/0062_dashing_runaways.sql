CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`show_reasoning` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
