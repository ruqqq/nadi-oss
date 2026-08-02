ALTER TABLE `attachments` ADD `extracted_text` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `extracted_source` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `extracted_at` integer;--> statement-breakpoint
ALTER TABLE `attachments` ADD `extracted_error` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `extracted_attempts` integer DEFAULT 0 NOT NULL;