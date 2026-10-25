-- 售后体系（对齐淘宝：仅退款 / 退货退款）

CREATE TABLE `AfterSale` (
  `id`                     INTEGER NOT NULL AUTO_INCREMENT,
  `afterSaleNo`            VARCHAR(32) NOT NULL,
  `orderId`                INTEGER NOT NULL,
  `orderNo`                VARCHAR(32) NOT NULL,
  `userId`                 INTEGER NOT NULL,
  `type`                   ENUM('REFUND_ONLY','RETURN_REFUND') NOT NULL,
  `status`                 ENUM('PENDING','AGREED','WAIT_RETURN','RETURNING','REFUNDING','COMPLETED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `reason`                 VARCHAR(32) NOT NULL,
  `description`            VARCHAR(512) NULL,
  `images`                 VARCHAR(2048) NOT NULL DEFAULT '[]',
  `refundAmount`           INTEGER NOT NULL,
  `refundedAmount`         INTEGER NOT NULL DEFAULT 0,
  `refundNo`               VARCHAR(64) NULL,
  `rejectReason`           VARCHAR(256) NULL,
  `returnLogisticsCompany` VARCHAR(64) NULL,
  `returnTrackingNo`       VARCHAR(64) NULL,
  `agreedAt`               DATETIME(3) NULL,
  `returnedAt`             DATETIME(3) NULL,
  `receivedAt`             DATETIME(3) NULL,
  `refundedAt`             DATETIME(3) NULL,
  `rejectedAt`             DATETIME(3) NULL,
  `cancelledAt`            DATETIME(3) NULL,
  `createdAt`              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`              DATETIME(3) NOT NULL,

  UNIQUE INDEX `AfterSale_afterSaleNo_key` (`afterSaleNo`),
  INDEX `AfterSale_orderNo_idx` (`orderNo`),
  INDEX `AfterSale_userId_createdAt_idx` (`userId`, `createdAt`),
  INDEX `AfterSale_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `AfterSale_orderId_status_idx` (`orderId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AfterSale`
  ADD CONSTRAINT `AfterSale_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `AfterSale_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 订单表补售后相关字段：
--   afterSaleStatus：订单维度汇总的售后状态（列表页/详情页直接展示，免 N+1 查询）
--   refundedAmount：该订单已退款总额（分），用于校验超额退款
ALTER TABLE `Order` ADD COLUMN `refundedAmount` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `Order` ADD COLUMN `afterSaleStatus` VARCHAR(16) NULL;
