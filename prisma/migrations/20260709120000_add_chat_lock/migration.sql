-- Per-user password lock on a chat. Each participant has their own row; a
-- user locking a chat has no effect on other participants. Unrelated to
-- Chat.isLocked (group-freeze admin flag), which stays as-is.

CREATE TABLE `ChatLock` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `userId`       INT NOT NULL,
  `chatId`       INT NOT NULL,
  `passwordHash` VARCHAR(191) NOT NULL,
  `createdAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`    DATETIME(3) NOT NULL,

  UNIQUE INDEX `ChatLock_userId_chatId_key`(`userId`, `chatId`),
  INDEX `ChatLock_userId_idx`(`userId`),
  INDEX `ChatLock_chatId_idx`(`chatId`),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ChatLock`
  ADD CONSTRAINT `ChatLock_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ChatLock`
  ADD CONSTRAINT `ChatLock_chatId_fkey`
    FOREIGN KEY (`chatId`) REFERENCES `Chat`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
