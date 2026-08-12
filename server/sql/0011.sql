-- Scheduled publishing support
ALTER TABLE `feeds` ADD COLUMN `scheduled_at` integer;
--> statement-breakpoint
UPDATE `info` SET `value` = '11' WHERE `key` = 'migration_version';
