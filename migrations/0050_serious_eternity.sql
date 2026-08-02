CREATE TABLE `workbench_secret_names` (
	`workbench_id` text NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workbench_id`, `name`),
	FOREIGN KEY (`workbench_id`) REFERENCES `workbenches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `workbenches` ADD `secret_names_backfilled` integer DEFAULT false NOT NULL;