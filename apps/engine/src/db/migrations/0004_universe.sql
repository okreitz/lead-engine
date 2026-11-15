CREATE TABLE `universe_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`url` text,
	`file_name` text NOT NULL,
	`state` text NOT NULL,
	`filter` text,
	`bytes_total` integer,
	`bytes_done` integer DEFAULT 0 NOT NULL,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`rows_kept` integer DEFAULT 0 NOT NULL,
	`rows_inserted` integer DEFAULT 0 NOT NULL,
	`rows_updated` integer DEFAULT 0 NOT NULL,
	`dropped` text DEFAULT '{}' NOT NULL,
	`error` text,
	`job_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `universe_imports_workspace_idx` ON `universe_imports` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `companies` ADD `universe` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `size_min` integer;--> statement-breakpoint
ALTER TABLE `companies` ADD `size_max` integer;--> statement-breakpoint
ALTER TABLE `companies` ADD `name_key` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `cik` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `ticker` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `origins` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `companies_universe_state_idx` ON `companies` (`universe`,`state`);--> statement-breakpoint
CREATE INDEX `companies_name_key_idx` ON `companies` (`name_key`);--> statement-breakpoint
CREATE INDEX `companies_cik_idx` ON `companies` (`cik`);