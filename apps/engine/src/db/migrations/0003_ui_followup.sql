CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`entity` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_views_workspace_idx` ON `saved_views` (`workspace_id`,`entity`);--> statement-breakpoint
ALTER TABLE `cost_ledger` ADD `entity_type` text;--> statement-breakpoint
ALTER TABLE `cost_ledger` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `offer_versions` ADD `rationale` text;--> statement-breakpoint
ALTER TABLE `offer_versions` ADD `review` text;--> statement-breakpoint
ALTER TABLE `provider_keys` ADD `last_used_at` integer;