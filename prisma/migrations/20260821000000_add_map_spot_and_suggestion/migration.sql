-- CreateTable
CREATE TABLE `MapSpot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `placeId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `address` VARCHAR(300) NULL,
    `city` VARCHAR(120) NULL,
    `categoryKey` VARCHAR(40) NOT NULL,
    `description` VARCHAR(1000) NULL,
    `imageUrl` VARCHAR(500) NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `radiusMeters` INTEGER NOT NULL DEFAULT 50,
    `points` INTEGER NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `fromSuggestionId` INTEGER NULL,
    `createdByAdmin` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MapSpot_placeId_key`(`placeId`),
    INDEX `MapSpot_categoryKey_active_idx`(`categoryKey`, `active`),
    INDEX `MapSpot_active_latitude_longitude_idx`(`active`, `latitude`, `longitude`),
    INDEX `MapSpot_imageUrl_idx`(`imageUrl`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SpotSuggestion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `address` VARCHAR(300) NULL,
    `categoryKey` VARCHAR(40) NOT NULL,
    `note` VARCHAR(1000) NULL,
    `imageUrl` VARCHAR(500) NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `rejectReason` VARCHAR(500) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewedByAdmin` VARCHAR(100) NULL,
    `mapSpotId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SpotSuggestion_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `SpotSuggestion_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `SpotSuggestion_imageUrl_idx`(`imageUrl`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SpotSuggestion` ADD CONSTRAINT `SpotSuggestion_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

