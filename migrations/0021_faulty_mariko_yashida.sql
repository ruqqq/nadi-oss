CREATE TABLE `archived_message` (
	`thread_id` text NOT NULL,
	`seq` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`thread_id`, `seq`)
);
