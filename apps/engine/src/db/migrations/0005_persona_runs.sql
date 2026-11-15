CREATE TABLE `persona_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`company_id` text NOT NULL,
	`position` integer NOT NULL,
	`rule_fit` integer NOT NULL,
	`state` text NOT NULL,
	`llm_fit` integer,
	`fit` integer,
	`reasons` text,
	`evidence` text,
	`evidence_url` text,
	`note` text,
	`account_id` text,
	`scored_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `persona_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `persona_candidates_run_company_uq` ON `persona_candidates` (`run_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `persona_candidates_run_idx` ON `persona_candidates` (`run_id`,`state`,`position`);--> statement-breakpoint
CREATE TABLE `persona_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`offer_version_id` text NOT NULL,
	`filters` text NOT NULL,
	`limit` integer NOT NULL,
	`threshold` integer NOT NULL,
	`options` text NOT NULL,
	`state` text NOT NULL,
	`counts` text NOT NULL,
	`estimate_usd` real NOT NULL,
	`tech_note` text,
	`error` text,
	`job_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offer_version_id`) REFERENCES `offer_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `persona_runs_workspace_idx` ON `persona_runs` (`workspace_id`,`created_at`);