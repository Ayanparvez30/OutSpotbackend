-- CreateTable
CREATE TABLE `AppVersionSetting` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `minBuild` INTEGER NOT NULL,
    `latestBuild` INTEGER NOT NULL,
    `forceUpdate` BOOLEAN NOT NULL DEFAULT false,
    `message` VARCHAR(500) NULL,
    `storeUrlAndroid` VARCHAR(500) NULL,
    `storeUrlIos` VARCHAR(500) NULL,
    `createdByAdmin` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AppVersionSetting_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

