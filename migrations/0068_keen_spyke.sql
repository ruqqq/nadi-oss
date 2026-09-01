DROP TABLE `active_containers`;--> statement-breakpoint
CREATE INDEX `idx_agent_sandboxes_status` ON `agent_sandboxes` (`status`,`last_used_at`);