CREATE TABLE `agent_skills` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL,
  `body` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `idx_agent_skills_agent` ON `agent_skills` (`workspace_id`,`agent_id`,`archived_at`);
CREATE INDEX `idx_agent_skills_name` ON `agent_skills` (`workspace_id`,`agent_id`,`name`);
CREATE UNIQUE INDEX `idx_agent_skills_active_name_unique` ON `agent_skills` (`workspace_id`,`agent_id`,`name`) WHERE `archived_at` IS NULL;
