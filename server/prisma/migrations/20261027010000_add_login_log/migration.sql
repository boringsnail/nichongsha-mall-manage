-- 新增 LoginLog：小程序每次登录换会话时写一条，用于「用户访问」里的登录记录。
--
-- 之前登录只签 JWT、不留痕，商家问「这个用户多久来一次 / 是不是新客」答不上来。
-- 只记「谁、什么时候、从哪、什么设备」，不记任何凭证。
-- userId 允许为空且 ON DELETE SET NULL：用户被删后历史记录仍保留，openid 快照还在。

CREATE TABLE `LoginLog` (
    `id`        INTEGER      NOT NULL AUTO_INCREMENT,
    `userId`    INTEGER      NULL,
    `openid`    VARCHAR(64)  NOT NULL,
    `via`       VARCHAR(16)  NULL,
    `source`    VARCHAR(16)  NOT NULL DEFAULT 'miniprogram',
    `ip`        VARCHAR(64)  NULL,
    `userAgent` VARCHAR(256) NULL,
    `isNewUser` BOOLEAN      NOT NULL DEFAULT false,
    `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LoginLog_createdAt_idx` (`createdAt`),
    INDEX `LoginLog_userId_createdAt_idx` (`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LoginLog`
    ADD CONSTRAINT `LoginLog_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
