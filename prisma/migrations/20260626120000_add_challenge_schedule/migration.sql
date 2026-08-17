-- CreateTable
CREATE TABLE `ChallengeSchedule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `frequency` ENUM('DAILY', 'WEEKLY') NOT NULL,
    `windowKey` VARCHAR(191) NOT NULL,
    `challengeId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ChallengeSchedule_challengeId_idx`(`challengeId`),
    UNIQUE INDEX `ChallengeSchedule_frequency_windowKey_key`(`frequency`, `windowKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ChallengeSchedule` ADD CONSTRAINT `ChallengeSchedule_challengeId_fkey` FOREIGN KEY (`challengeId`) REFERENCES `Challenge`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
