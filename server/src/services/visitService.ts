import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

/**
 * 「用户访问」数据服务：商品浏览 / 登录 / 购物车。
 *
 * 三个数据源的脾气完全不一样，别混着算：
 *   - 浏览、登录是**流水**，按时间窗（7/30/90 天）过滤，可以翻页
 *   - 购物车是**当前快照**：下单时对应 SKU 的行会被删掉（orderService），
 *     所以它没有「历史」，只有「此刻还没结算的东西」
 */
const VIEW_EVENT = 'product_view';

/** 本地时区当天 0 点，和 statsService 保持同一口径 */
function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 近 N 天的起点（含今天）：days=1 就是今天 0 点 */
function rangeFrom(days: number) {
  const safe = Math.min(Math.max(days, 1), 365);
  return new Date(startOfToday().getTime() - (safe - 1) * 86400000);
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/* ---------------------------------------------------------------- 概览 */
export async function visitOverview(days = 30) {
  const d = Math.min(Math.max(days, 1), 365);
  const from = rangeFrom(d);
  // 加购超过 24 小时还没结算 → 大概率是弃购，单独报一个数
  const staleBefore = new Date(Date.now() - 24 * 3600 * 1000);

  const [viewRow, loginCount, loginUserRows, newUsers, cartRow] = await Promise.all([
    prisma.$queryRaw<{ pv: unknown; uv: unknown; productCount: unknown; guestViews: unknown }[]>(
      Prisma.sql`
        SELECT COUNT(*) AS pv,
               COUNT(DISTINCT COALESCE(CAST(userId AS CHAR), openid, sessionId)) AS uv,
               COUNT(DISTINCT productId) AS productCount,
               SUM(CASE WHEN userId IS NULL THEN 1 ELSE 0 END) AS guestViews
        FROM UserEvent
        WHERE eventType = ${VIEW_EVENT} AND createdAt >= ${from}
      `,
    ),
    prisma.loginLog.count({ where: { createdAt: { gte: from } } }),
    prisma.loginLog.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: from }, userId: { not: null } },
      _count: { _all: true },
    }),
    prisma.loginLog.count({ where: { createdAt: { gte: from }, isNewUser: true } }),
    prisma.$queryRaw<{ items: unknown; users: unknown; amount: unknown; stale: unknown }[]>(
      Prisma.sql`
        SELECT COUNT(*) AS items,
               COUNT(DISTINCT c.userId) AS users,
               COALESCE(SUM(s.price * c.quantity), 0) AS amount,
               SUM(CASE WHEN c.createdAt < ${staleBefore} THEN 1 ELSE 0 END) AS stale
        FROM Cart c JOIN Sku s ON s.id = c.skuId
      `,
    ),
  ]);

  const v = viewRow[0] ?? {};
  const pv = num(v.pv);
  const guestViews = num(v.guestViews);
  const c = cartRow[0] ?? {};

  return {
    days: d,
    views: {
      pv,
      uv: num(v.uv),
      productCount: num(v.productCount),
      guestViews,
      /** 游客占比（百分比，一位小数）：越高说明「看的人多、留的人少」 */
      guestRate: pv > 0 ? Math.round((guestViews / pv) * 1000) / 10 : 0,
    },
    logins: { count: loginCount, users: loginUserRows.length, newUsers },
    cart: {
      items: num(c.items),
      users: num(c.users),
      amount: num(c.amount),
      /** 加购超 24 小时未结算的条目数 */
      stale: num(c.stale),
    },
  };
}

/* ---------------------------------------------------------------- 浏览记录 */
export interface VisitQuery {
  days?: number;
  userId?: number;
  page?: number;
  size?: number;
}

export async function viewLogs(q: VisitQuery) {
  const page = Math.max(1, q.page ?? 1);
  const size = Math.min(100, Math.max(1, q.size ?? 20));
  const from = rangeFrom(q.days ?? 30);

  const where: Prisma.UserEventWhereInput = { eventType: VIEW_EVENT, createdAt: { gte: from } };
  if (q.userId) where.userId = q.userId;

  const [total, rows] = await Promise.all([
    prisma.userEvent.count({ where }),
    prisma.userEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
    }),
  ]);

  // UserEvent 刻意没建到 User/Product 的外键（埋点不能因为主表缺失而失败），
  // 所以这里手工批量补名字，避免 N+1
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is number => x !== null))];
  const productIds = [...new Set(rows.map((r) => r.productId).filter((x): x is number => x !== null))];

  const [users, products] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, nickname: true, openid: true },
        })
      : [],
    productIds.length
      ? prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, coverImage: true, minPrice: true, status: true },
        })
      : [],
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const productMap = new Map(products.map((p) => [p.id, p]));

  return {
    days: Number(q.days ?? 30),
    total,
    page,
    size,
    list: rows.map((r) => {
      const u = r.userId ? userMap.get(r.userId) : undefined;
      const p = r.productId ? productMap.get(r.productId) : undefined;
      return {
        id: r.id,
        createdAt: r.createdAt,
        sessionId: r.sessionId,
        skuId: r.skuId,
        /** 登录用户才有；游客为 null，只留 openid 快照（可能也为空） */
        user: u ? { id: u.id, nickname: u.nickname, openid: u.openid } : null,
        openid: r.openid,
        product: p
          ? { id: p.id, name: p.name, coverImage: p.coverImage, minPrice: p.minPrice, status: p.status }
          : r.productId
            ? { id: r.productId, name: '商品已删除', coverImage: '', minPrice: 0, status: null }
            : null,
      };
    }),
  };
}

/* ---------------------------------------------------------------- 登录记录 */
export async function loginLogs(q: VisitQuery) {
  const page = Math.max(1, q.page ?? 1);
  const size = Math.min(100, Math.max(1, q.size ?? 20));
  const from = rangeFrom(q.days ?? 30);

  const where: Prisma.LoginLogWhereInput = { createdAt: { gte: from } };
  if (q.userId) where.userId = q.userId;

  const [total, rows] = await Promise.all([
    prisma.loginLog.count({ where }),
    prisma.loginLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
      include: { user: { select: { id: true, nickname: true, openid: true } } },
    }),
  ]);

  return {
    days: Number(q.days ?? 30),
    total,
    page,
    size,
    list: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      via: r.via,
      source: r.source,
      ip: r.ip,
      userAgent: r.userAgent,
      isNewUser: r.isNewUser,
      openid: r.openid,
      user: r.user ? { id: r.user.id, nickname: r.user.nickname, openid: r.user.openid } : null,
    })),
  };
}

/* ---------------------------------------------------------------- 购物车 */
export async function cartItems(q: { userId?: number; page?: number; size?: number }) {
  const page = Math.max(1, q.page ?? 1);
  const size = Math.min(100, Math.max(1, q.size ?? 20));

  const where: Prisma.CartWhereInput = {};
  if (q.userId) where.userId = q.userId;

  const [total, rows, agg] = await Promise.all([
    prisma.cart.count({ where }),
    prisma.cart.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
      include: {
        sku: { include: { product: { select: { id: true, name: true, coverImage: true, status: true } } } },
        user: { select: { id: true, nickname: true, openid: true } },
      },
    }),
    prisma.cart.aggregate({ where, _sum: { quantity: true } }),
  ]);

  return {
    total,
    page,
    size,
    /** 当前筛选下的总件数（不是条数） */
    totalQuantity: agg._sum.quantity ?? 0,
    list: rows.map((r) => ({
      id: r.id,
      quantity: r.quantity,
      checked: r.checked,
      createdAt: r.createdAt,
      price: r.sku.price,
      subtotal: r.sku.price * r.quantity,
      stock: r.sku.stock,
      skuId: r.skuId,
      specName: r.sku.specName,
      product: {
        id: r.sku.product.id,
        name: r.sku.product.name,
        coverImage: r.sku.product.coverImage,
        status: r.sku.product.status,
      },
      user: { id: r.user.id, nickname: r.user.nickname, openid: r.user.openid },
    })),
  };
}
