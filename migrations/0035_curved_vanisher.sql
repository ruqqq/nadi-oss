CREATE TABLE `archived_compaction` (
	`thread_id` text NOT NULL,
	`seq` integer NOT NULL,
	`compaction_id` text NOT NULL,
	`from_message_id` text NOT NULL,
	`to_message_id` text NOT NULL,
	`summary` text NOT NULL,
	PRIMARY KEY(`thread_id`, `seq`)
);
