CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`network_domains` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `skills` ("id", "workspace_id", "agent_id", "name", "description", "body", "network_domains", "enabled", "created_at", "updated_at", "archived_at") SELECT "id", "workspace_id", "agent_id", "name", "description", "body", "network_domains", "enabled", "created_at", "updated_at", "archived_at" FROM `agent_skills`;--> statement-breakpoint
CREATE INDEX `idx_skills_agent` ON `skills` (`workspace_id`,`agent_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_skills_name` ON `skills` (`workspace_id`,`agent_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skills_library_name_unique` ON `skills` (`workspace_id`,`name`) WHERE "skills"."agent_id" IS NULL AND "skills"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skills_agent_name_unique` ON `skills` (`workspace_id`,`agent_id`,`name`) WHERE "skills"."agent_id" IS NOT NULL AND "skills"."archived_at" IS NULL;--> statement-breakpoint
CREATE TABLE `agent_skill_exclusions` (
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_agent_skill_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`encoding` text NOT NULL,
	`mime_type` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_agent_skill_resources`("id", "skill_id", "path", "kind", "encoding", "mime_type", "content", "created_at", "updated_at") SELECT "id", "skill_id", "path", "kind", "encoding", "mime_type", "content", "created_at", "updated_at" FROM `agent_skill_resources`;--> statement-breakpoint
DROP TABLE `agent_skill_resources`;--> statement-breakpoint
ALTER TABLE `__new_agent_skill_resources` RENAME TO `agent_skill_resources`;--> statement-breakpoint
CREATE INDEX `idx_agent_skill_resources_skill` ON `agent_skill_resources` (`skill_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_skill_resources_skill_path` ON `agent_skill_resources` (`skill_id`,`path`);
