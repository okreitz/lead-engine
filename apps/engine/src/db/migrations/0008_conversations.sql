CREATE TABLE `conversation_sources` (
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cursor` text DEFAULT '{}' NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`last_status` text,
	`last_error` text,
	`last_found` integer,
	`last_new` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `source`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `engine_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`excerpt` text NOT NULL,
	`author` text,
	`posted_at` integer NOT NULL,
	`matched_phrase` text NOT NULL,
	`phrase_kind` text NOT NULL,
	`score_status` text DEFAULT 'pending' NOT NULL,
	`intent` integer,
	`label` text,
	`pain` text,
	`stage` text,
	`persona` text,
	`suggested_reply` text,
	`reply_draft` text,
	`company_mentioned` text,
	`self_promo` integer DEFAULT false NOT NULL,
	`score_reason` text,
	`score_error` text,
	`scored_at` integer,
	`state` text DEFAULT 'new' NOT NULL,
	`feedback` text,
	`feedback_at` integer,
	`snoozed_until` integer,
	`account_id` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_workspace_url_uq` ON `threads` (`workspace_id`,`url`);--> statement-breakpoint
CREATE INDEX `threads_inbox_idx` ON `threads` (`workspace_id`,`state`,`intent`);--> statement-breakpoint
CREATE INDEX `threads_score_idx` ON `threads` (`workspace_id`,`score_status`);--> statement-breakpoint
CREATE INDEX `threads_external_idx` ON `threads` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `threads_expires_idx` ON `threads` (`expires_at`);