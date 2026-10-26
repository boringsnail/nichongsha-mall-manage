import { prisma } from '../db.js';
import { AFTER_SALE_REASONS, type AfterSaleReason } from './afterSaleService.js';

/**
 * 订单 / 售后告警源。
 *
 * 给管控台的「强提醒」提供数据：新支付待发货的订单、待处理的售后申请。
 * 这里刻意只返回「需要人动手」的单（PAID / PENDING），不返回已发货、已完成，
 * 否则每次轮询都会把历史单再报一遍，提醒会变成噪音。
 *
 * 前端按单号做差集，只有「没见过的新单」才触发声音/语音/桌面通知；
 * 首次进入只做基线播种，不播报。
 */

/** 回看窗口：覆盖商家离开一两天再回来的场景，又不至于把陈年旧单全推一遍 */
const LOOKBACK_HOURS = 72;
const MAX_ITEMS = 20;

export interface AlertOrder {
  orderNo: string;
  totalAmount: number;
  itemCount: number;
  buyer: string;
  createdAt: string;
}

export interface AlertAfterSale {
  afterSaleNo: string;
  orderNo: string;
  refundAmount: number;
  type: string;
  reasonText: string;
  createdAt: string;
}

export interface AdminAlerts {
  serverTime: string;
  lookbackHours: number;
  orders: AlertOrder[];
  afterSales: AlertAfterSale[];
  /** 待发货总数（全量口径，不受回看窗口限制） */
  pendingShipCount: number;
  /** 待处理售后总数（全量口径） */
  pendingAfterSaleCount: number;
}

export async function listAdminAlerts(): Promise<AdminAlerts> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  const [orders, afterSales, pendingShipCount, pendingAfterSaleCount] = await Promise.all([
    prisma.order.findMany({
      where: { status: 'PAID', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: MAX_ITEMS,
      select: {
        orderNo: true,
        totalAmount: true,
        createdAt: true,
        user: { select: { nickname: true, openid: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.afterSale.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: MAX_ITEMS,
      select: {
        afterSaleNo: true,
        orderNo: true,
        refundAmount: true,
        type: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.order.count({ where: { status: 'PAID' } }),
    prisma.afterSale.count({ where: { status: 'PENDING' } }),
  ]);

  return {
    serverTime: new Date().toISOString(),
    lookbackHours: LOOKBACK_HOURS,
    orders: orders.map((o) => ({
      orderNo: o.orderNo,
      totalAmount: o.totalAmount,
      itemCount: o._count.items,
      // 微信昵称可能为空，兜底成 openid 后 4 位，避免整行都是「微信用户」
      buyer: o.user.nickname || `用户${o.user.openid.slice(-4)}`,
      createdAt: o.createdAt.toISOString(),
    })),
    afterSales: afterSales.map((a) => ({
      afterSaleNo: a.afterSaleNo,
      orderNo: a.orderNo,
      refundAmount: a.refundAmount,
      type: a.type,
      reasonText: AFTER_SALE_REASONS[a.reason as AfterSaleReason] ?? a.reason,
      createdAt: a.createdAt.toISOString(),
    })),
    pendingShipCount,
    pendingAfterSaleCount,
  };
}
