CREATE TABLE `user_voice_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
