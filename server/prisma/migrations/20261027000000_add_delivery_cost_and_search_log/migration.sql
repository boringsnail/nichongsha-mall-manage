-- 1) 订单加「配送成本」：商家实际付给骑手/快递的钱（分）
--
-- 和已有的 freight 不是一个方向的钱：
--   freight      = 顾客付给我们的运费 → 计入总营业额
--   deliveryCost = 我们付给骑手/快递的成本 → 算净营业额时扣掉
-- 历史订单默认为 0（没录就是没录，不能凭空编一个成本出来）。
--
-- 2) 新增 SearchLog：小程序每次搜索上报一条，用于「搜索分析」
--
-- userId 可空且不加外键级联删除（ON DELETE SET NULL）：未登录也能搜，
-- 用户被删掉时搜索记录仍然保留，只是不再归属到人。

ALTER TABLE `Order` ADD COLUMN `deliveryCost` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `SearchLog` (
    `id`          INTEGER      NOT NULL AUTO_INCREMENT,
    `userId`      INTEGER      NULL,
    `keyword`     VARCHAR(64)  NOT NULL,
    `resultCount` INTEGER      NOT NULL DEFAULT 0,
    `source`      VARCHAR(16)  NOT NULL DEFAULT 'miniprogram',
    `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SearchLog_createdAt_idx` (`createdAt`),
    INDEX `SearchLog_userId_createdAt_idx` (`userId`, `createdAt`),
    INDEX `SearchLog_keyword_idx` (`keyword`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SearchLog`
    ADD CONSTRAINT `SearchLog_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
