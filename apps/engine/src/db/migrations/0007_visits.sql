CREATE TABLE `daily_salts` (
	`day` text PRIMARY KEY NOT NULL,
	`salt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ip_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`prefix` text NOT NULL,
	`ip_start` text NOT NULL,
	`ip_end` text NOT NULL,
	`prefix_len` integer NOT NULL,
	`company_domain` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`wrong` integer DEFAULT false NOT NULL,
	`seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ip_companies_lookup_idx` ON `ip_companies` (`workspace_id`,`ip_start`,`ip_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `ip_companies_prefix_uq` ON `ip_companies` (`workspace_id`,`prefix`,`company_domain`);--> statement-breakpoint
CREATE TABLE `ip_lookup_cache` (
	`workspace_id` text NOT NULL,
	`ip` text NOT NULL,
	`result` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `ip`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ip_lookup_cache_expires_idx` ON `ip_lookup_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`site_key` text NOT NULL,
	`intent_pages` text DEFAULT '[]' NOT NULL,
	`last_event_at` integer,
	`checked_at` integer,
	`check_ok` integer,
	`check_note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_site_key_unique` ON `sites` (`site_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_workspace_domain_uq` ON `sites` (`workspace_id`,`domain`);--> statement-breakpoint
CREATE TABLE `visit_daily` (
	`site_id` text NOT NULL,
	`day` text NOT NULL,
	`outcome` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`pageviews` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `outcome`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `visits` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`site_id` text NOT NULL,
	`account_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`path` text NOT NULL,
	`referrer` text,
	`utm` text,
	`match_source` text NOT NULL,
	`confidence` real NOT NULL,
	`ip_company_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `visits_site_at_idx` ON `visits` (`site_id`,`at`);--> statement-breakpoint
CREATE INDEX `visits_account_at_idx` ON `visits` (`account_id`,`at`);--> statement-breakpoint
CREATE INDEX `visits_session_idx` ON `visits` (`session_hash`,`account_id`);