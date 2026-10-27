-- 新增 MediaAsset：商家在后台直接上传商品图，不再手填图片 URL。
--
-- 为什么存数据库而不是对象存储：
-- 云托管容器是无状态的（重启即丢），本地磁盘不可用；接 COS 需要额外配置桶与密钥，
-- 而这里只有商品图这一种素材、体量小（前端已压到 ≤1600px / 单张 ≤1.2MB）。
-- 存 LONGBLOB 换来的好处是：零外部依赖、迁移即带、备份数据库就备份了图片。
--
-- sha256 唯一：同一张图重复上传直接复用，不会把库撑大。

CREATE TABLE `MediaAsset` (
    `id`        INTEGER      NOT NULL AUTO_INCREMENT,
    `mime`      VARCHAR(64)  NOT NULL,
    `byteSize`  INTEGER      NOT NULL,
    `width`     INTEGER      NOT NULL DEFAULT 0,
    `height`    INTEGER      NOT NULL DEFAULT 0,
    `sha256`    VARCHAR(64)  NOT NULL,
    `data`      LONGBLOB     NOT NULL,
    `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `MediaAsset_sha256_key` (`sha256`),
    INDEX `MediaAsset_createdAt_idx` (`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
