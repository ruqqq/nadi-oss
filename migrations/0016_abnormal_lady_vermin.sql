ALTER TABLE `agents` ADD `sandbox_network_domain_allowlist` text;--> statement-breakpoint
ALTER TABLE `workspace_sandbox_settings` ADD `network_restriction_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_sandbox_settings` ADD `network_domain_allowlist` text DEFAULT '' NOT NULL;