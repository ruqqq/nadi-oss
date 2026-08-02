CREATE TABLE `agent_memories` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `content` text NOT NULL,
  `title` text,
  `kind` text DEFAULT 'fact' NOT NULL,
  `source_thread_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE INDEX `idx_agent_memories_agent` ON `agent_memories` (`workspace_id`,`agent_id`,`archived_at`,`updated_at`);
CREATE INDEX `idx_agent_memories_source_thread` ON `agent_memories` (`source_thread_id`);
