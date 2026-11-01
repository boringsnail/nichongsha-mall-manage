-- 配送照片：商家发货/送达时拍一张存证，小程序订单详情里展示。
-- 存 JSON 数组（绝对地址），一张单最多 3 张；用 TEXT 而不是 VARCHAR(191)，
-- 因为地址本身就有 80~120 字符，3 张塞不下。
ALTER TABLE `Order` ADD COLUMN `deliveryPhotos` TEXT NULL;
