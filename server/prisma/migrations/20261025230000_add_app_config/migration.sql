-- 键值配置表：让「公告内容」「售后自动同意时长」这类设置可以在后台直接改，
-- 不用改环境变量再重启容器。
--
-- 为什么用 key-value 而不是宽表：
--   配置项会持续增加（后面还要补运费门槛、客服微信等），宽表每加一项都要写迁移，
--   而 key-value 加配置只改 configService 里的默认值表，不动库结构。
-- 值统一存字符串，类型转换与默认值兜底都在 configService 里做。

CREATE TABLE `AppConfig` (
    `key`       VARCHAR(64) NOT NULL,
    `value`     TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
