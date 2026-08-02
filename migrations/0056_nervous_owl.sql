ALTER TABLE `agents` ADD `reasoning_effort` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `model_supports_reasoning` integer;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `reasoning_effort` text;--> statement-breakpoint
ALTER TABLE `thread_index` ADD `model_supports_reasoning` integer;--> statement-breakpoint
-- Hand-added backfill (see docs/superpowers/specs/2026-08-01-composer-reasoning-effort-design.md).
-- `show_reasoning = 0` used to mean "do not think at all", not merely "hide the
-- thinking". Without this, every such row silently starts buying reasoning
-- tokens on its next turn. drizzle only emits the ALTERs above, and the
-- alternatives (a hand-edited journal, or resolving this at read time) are worse.
UPDATE `agents` SET `reasoning_effort` = 'off' WHERE `show_reasoning` = 0;--> statement-breakpoint
-- NULL rows are left NULL: they inherit from the agent, which was just fixed.
UPDATE `thread_index` SET `reasoning_effort` = 'off' WHERE `show_reasoning` = 0;
