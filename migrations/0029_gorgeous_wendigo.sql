CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text,
	`inviter_user_id` text NOT NULL,
	`email` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`accepted_user_id` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`accepted_at` integer,
	FOREIGN KEY (`inviter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE INDEX `idx_invites_email` ON `invites` (`email`);--> statement-breakpoint
CREATE INDEX `idx_invites_inviter` ON `invites` (`inviter_user_id`);--> statement-breakpoint
CREATE TABLE `waiting_list` (
	`email` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
