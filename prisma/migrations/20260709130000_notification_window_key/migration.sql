-- Once-per-window idempotency key for challenge notifications.
--
-- Existing rows keep windowKey = NULL. MySQL allows duplicate NULLs in a UNIQUE
-- index, so adding the index below cannot fail on historical data — including
-- the duplicate DAILY_CHALLENGE / WEEKLY_CHALLENGE rows this change exists to
-- prevent. Clean those up separately if desired; they are inert.
ALTER TABLE `Notification` ADD COLUMN `windowKey` VARCHAR(191) NULL;

-- From here on, one DAILY_CHALLENGE per (user, day) and one WEEKLY_CHALLENGE
-- per (user, week) is enforced by the database rather than by a check-then-
-- insert guard, which raced across processes.
CREATE UNIQUE INDEX `Notification_userId_type_windowKey_key`
  ON `Notification`(`userId`, `type`, `windowKey`);
