-- 修复：默认 VARCHAR(191) 装不下真实数据
--   1) Product.images  轮播图 JSON 数组（美团商品最多 6 张图 URL，实测 527 字符）→ 244 个商品导入失败
--   2) Product.description / coverImage、Order.addressSnapshot / remark 同样加长，避免生产数据被截断
ALTER TABLE `Product` MODIFY COLUMN `images` VARCHAR(2048) NOT NULL DEFAULT '[]';
ALTER TABLE `Product` MODIFY COLUMN `description` VARCHAR(2048) NULL;
ALTER TABLE `Product` MODIFY COLUMN `coverImage` VARCHAR(512) NOT NULL;
ALTER TABLE `Order` MODIFY COLUMN `addressSnapshot` VARCHAR(1024) NOT NULL;
ALTER TABLE `Order` MODIFY COLUMN `remark` VARCHAR(512) NULL;
