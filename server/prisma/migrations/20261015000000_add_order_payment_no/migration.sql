-- 订单表增加微信支付交易号（对账 / 退款用）
ALTER TABLE `Order` ADD COLUMN `paymentNo` VARCHAR(191) NULL;
