ALTER TABLE `workbench_repositories` RENAME TO `agent_repositories`;--> statement-breakpoint
ALTER TABLE `agent_repositories` RENAME COLUMN `workbench_id` TO `agent_id`;--> statement-breakpoint
DROP INDEX `idx_workbench_repositories_workbench`;--> statement-breakpoint
CREATE INDEX `idx_agent_repositories_agent` ON `agent_repositories` (`agent_id`);--> statement-breakpoint
ALTER TABLE `workbench_secret_names` RENAME TO `agent_secret_names`;--> statement-breakpoint
ALTER TABLE `agent_secret_names` RENAME COLUMN `workbench_id` TO `agent_id`;--> statement-breakpoint
CREATE TABLE `agent_sandboxes` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`sprite_name` text,
	`status` text NOT NULL,
	`generation` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `setup_script` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `resource_profile` text DEFAULT 'small' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `sandbox_image`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `sandbox_snapshot`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `sandbox_resource_profile`;
