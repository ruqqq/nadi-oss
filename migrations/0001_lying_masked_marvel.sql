CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
DROP INDEX `sessions_token_hash_unique`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `token` text NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `updated_at` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ip_address` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_agent` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `token_hash`;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `image` text;--> statement-breakpoint
ALTER TABLE `users` ADD `updated_at` integer NOT NULL;