CREATE TABLE `agent_skill_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`encoding` text NOT NULL,
	`mime_type` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `agent_skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_skill_resources_skill` ON `agent_skill_resources` (`skill_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_skill_resources_skill_path` ON `agent_skill_resources` (`skill_id`,`path`);--> statement-breakpoint
ALTER TABLE `agent_skills` ADD `network_domains` text;