-- CreateTable
CREATE TABLE `UserEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventType` VARCHAR(32) NOT NULL,
    `userId` INTEGER NULL,
    `openid` VARCHAR(64) NULL,
    `sessionId` VARCHAR(64) NULL,
    `productId` INTEGER NULL,
    `skuId` INTEGER NULL,
    `orderNo` VARCHAR(32) NULL,
    `amount` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UserEvent_eventType_createdAt_idx`(`eventType`, `createdAt`),
    INDEX `UserEvent_createdAt_idx`(`createdAt`),
    INDEX `UserEvent_userId_idx`(`userId`),
    INDEX `UserEvent_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
