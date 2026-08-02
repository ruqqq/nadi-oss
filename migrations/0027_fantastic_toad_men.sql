ALTER TABLE `agents` ADD `sandbox_resource_profile` text;--> statement-breakpoint
ALTER TABLE `workspace_sandbox_settings` ADD `provider_config_json` text;--> statement-breakpoint
ALTER TABLE `workspace_sandbox_settings` ADD `default_resource_profile` text DEFAULT 'small' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_sandbox_settings` ADD `recovery_ttl_ms` integer DEFAULT 86400000 NOT NULL;