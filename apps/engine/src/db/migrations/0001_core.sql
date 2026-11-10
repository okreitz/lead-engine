CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`company_id` text NOT NULL,
	`stage` text NOT NULL,
	`owner_user_id` text,
	`fit_score` real,
	`intent_score` real DEFAULT 0 NOT NULL,
	`priority` real DEFAULT 0 NOT NULL,
	`score_reasons` text,
	`scored_at` integer,
	`first_source` text NOT NULL,
	`first_source_at` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_workspace_company_uq` ON `accounts` (`workspace_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `accounts_workspace_priority_idx` ON `accounts` (`workspace_id`,`priority`);--> statement-breakpoint
CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text,
	`contact_id` text,
	`deal_id` text,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`meta` text,
	`at` integer NOT NULL,
	`user_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activities_account_idx` ON `activities` (`account_id`,`at`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`at` integer NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_log_workspace_at_idx` ON `audit_log` (`workspace_id`,`at`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`country` text NOT NULL,
	`state` text,
	`city` text,
	`industry` text,
	`naics` text,
	`size_range` text,
	`founded_year` integer,
	`sources` text DEFAULT '[]' NOT NULL,
	`tech` text DEFAULT '[]' NOT NULL,
	`tech_checked_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_domain_unique` ON `companies` (`domain`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`full_name` text NOT NULL,
	`title` text,
	`seniority` text,
	`department` text,
	`persona_match` text,
	`email` text,
	`email_domain` text,
	`email_status` text,
	`phone` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_account_idx` ON `contacts` (`account_id`);--> statement-breakpoint
CREATE INDEX `contacts_workspace_email_idx` ON `contacts` (`workspace_id`,`email`);--> statement-breakpoint
CREATE TABLE `cost_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`operation` text NOT NULL,
	`units` real NOT NULL,
	`usd` real NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	`free` integer DEFAULT false NOT NULL,
	`stream` text NOT NULL,
	`job_id` text,
	`meta` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cost_ledger_workspace_at_idx` ON `cost_ledger` (`workspace_id`,`at`);--> statement-breakpoint
CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`stage` text NOT NULL,
	`value_usd` real,
	`closed_at` integer,
	`outcome` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deals_account_idx` ON `deals` (`account_id`);--> statement-breakpoint
CREATE TABLE `field_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`source` text NOT NULL,
	`url` text,
	`fetched_at` integer NOT NULL,
	`confidence` real NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `field_sources_entity_idx` ON `field_sources` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_at` integer NOT NULL,
	`last_error` text,
	`wait_reason` text,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`state`,`run_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`user_id`, `workspace_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `next_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`text` text NOT NULL,
	`due_at` integer,
	`done_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `next_steps_account_idx` ON `next_steps` (`account_id`);--> statement-breakpoint
CREATE TABLE `offer_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`offer_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`data` text,
	`source` text NOT NULL,
	`input` text,
	`pages` text,
	`error` text,
	`job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approved_at` integer,
	`approved_by` text,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offer_versions_offer_version_uq` ON `offer_versions` (`offer_id`,`version`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`website_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_cache` (
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`provider` text NOT NULL,
	`operation` text NOT NULL,
	`result` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_keys` (
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `quota_usage` (
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`period` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`, `period`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text,
	`csrf_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text,
	`stream` text NOT NULL,
	`kind` text NOT NULL,
	`weight` real NOT NULL,
	`occurred_at` integer NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`evidence_url` text,
	`expires_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `signals_account_idx` ON `signals` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `suppressions_value_idx` ON `suppressions` (`kind`,`value`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`allowed_countries` text DEFAULT '["US"]' NOT NULL,
	`monthly_budget_usd` real DEFAULT 50 NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);