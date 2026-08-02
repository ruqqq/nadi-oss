ALTER TABLE `thread_index` RENAME COLUMN "routine_id" TO "automaton_id";--> statement-breakpoint
ALTER TABLE `thread_index` RENAME COLUMN "routine_run_id" TO "automaton_run_id";--> statement-breakpoint
CREATE TABLE `automata` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule_json` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_due_at` integer,
	`last_fired_at` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_automata_due` ON `automata` (`enabled`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `idx_automata_workspace` ON `automata` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `automaton_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automaton_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`due_at` integer,
	`trigger` text NOT NULL,
	`thread_id` text,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`automaton_id`) REFERENCES `automata`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_automaton_runs_automaton` ON `automaton_runs` (`automaton_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_automaton_runs_due` ON `automaton_runs` (`automaton_id`,`due_at`) WHERE "automaton_runs"."trigger" = 'scheduled';--> statement-breakpoint
DROP TABLE `routine_runs`;--> statement-breakpoint
DROP TABLE `routines`;--> statement-breakpoint
DROP INDEX `idx_thread_index_routine`;--> statement-breakpoint
CREATE INDEX `idx_thread_index_automaton` ON `thread_index` (`workspace_id`,`automaton_id`);