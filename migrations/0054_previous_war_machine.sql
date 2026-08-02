CREATE TABLE `provider_model_catalogs` (
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`models_json` text NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `provider_model_whitelists` (
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`models_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
