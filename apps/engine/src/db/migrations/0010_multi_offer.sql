ALTER TABLE `accounts` ADD `offer_id` text REFERENCES offers(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `offer_id` text REFERENCES offers(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `offer_id` text REFERENCES offers(id) ON DELETE SET NULL;--> statement-breakpoint
-- Threads were matched and scored with the workspace's most recently approved offer.
UPDATE `threads` SET `offer_id` = (
  SELECT v.`offer_id` FROM `offer_versions` v
  WHERE v.`workspace_id` = `threads`.`workspace_id` AND v.`status` = 'approved'
  ORDER BY v.`approved_at` DESC LIMIT 1
);--> statement-breakpoint
-- Accounts a persona run created belong to that run's offer.
UPDATE `accounts` SET `offer_id` = (
  SELECT v.`offer_id` FROM `persona_candidates` c
  JOIN `persona_runs` r ON r.`id` = c.`run_id`
  JOIN `offer_versions` v ON v.`id` = r.`offer_version_id`
  WHERE c.`account_id` = `accounts`.`id`
  ORDER BY c.`scored_at` LIMIT 1
) WHERE `offer_id` IS NULL;--> statement-breakpoint
-- Accounts converted from a thread belong to the thread's offer.
UPDATE `accounts` SET `offer_id` = (
  SELECT t.`offer_id` FROM `threads` t
  WHERE t.`account_id` = `accounts`.`id` AND t.`offer_id` IS NOT NULL
  ORDER BY t.`created_at` LIMIT 1
) WHERE `offer_id` IS NULL;--> statement-breakpoint
-- A site belongs to the offer drafted from the same domain.
UPDATE `sites` SET `offer_id` = (
  SELECT o.`id` FROM `offers` o
  WHERE o.`workspace_id` = `sites`.`workspace_id`
    AND (o.`website_url` LIKE '%://' || `sites`.`domain` || '/%'
      OR o.`website_url` LIKE '%://www.' || `sites`.`domain` || '/%')
  ORDER BY o.`created_at` LIMIT 1
);--> statement-breakpoint
CREATE INDEX `accounts_workspace_offer_idx` ON `accounts` (`workspace_id`,`offer_id`);--> statement-breakpoint
CREATE INDEX `threads_workspace_offer_idx` ON `threads` (`workspace_id`,`offer_id`);
