-- 物流模式：支持快递发货 / 同城配送 / 用户自提
--
-- 背景：商家除了发快递，还会「同城跑腿送过去」或「让用户到店自提」。
-- 这两种场景没有快递单号，原来的「物流公司 + 单号都必填」把它堵死了。
--
-- 取值对齐微信 upload_shipping_info.logistics_type：
--   1 = 实体物流配送（快递公司）
--   2 = 同城配送
--   3 = 虚拟商品（本项目不使用）
--   4 = 用户自提
--
-- 历史订单全部是快递发货，因此 DEFAULT 1 直接完成回填，不需要单独 UPDATE。

ALTER TABLE `Order` ADD COLUMN `logisticsType` INTEGER NOT NULL DEFAULT 1;
