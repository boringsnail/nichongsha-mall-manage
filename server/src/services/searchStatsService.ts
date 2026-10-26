import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';

/**
 * 搜索分析。
 *
 * 数据来源是 SearchLog（小程序每次搜索上报一条）。这里只做聚合，不写库。
 *
 * 三类问题分别对应三个视角：
 *   ① 「顾客在找什么」    → 热搜词
 *   ② 「顾客找什么没找到」 → 结果数为 0 的词（最有商业价值：缺货/没上架/叫法不一致）
 *   ③ 「谁在找」          → 按用户聚合的搜索记录
 */

function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 与 statsService 保持一致：把 UTC 存储换算成业务时区的日期
const STATS_TZ_OFFSET = /^[+-]\d{2}:\d{2}$/.test(process.env.STATS_TZ_OFFSET ?? '')
  ? (process.env.STATS_TZ_OFFSET as string)
  : '+08:00';

function localDayOf(column: string) {
  return Prisma.sql`DATE_FORMAT(CONVERT_TZ(${Prisma.raw(column)}, '+00:00', ${Prisma.raw(`'${STATS_TZ_OFFSET}'`)}), '%Y-%m-%d')`;
}

function windowStart(days: number) {
  const safeDays = Math.min(Math.max(days, 1), 365);
  return { safeDays, from: new Date(startOfToday().getTime() - (safeDays - 1) * 86400000) };
}

/**
 * 搜索总览：次数、人数、无结果率、热搜词、无结果词、每日趋势、按用户聚合
 */
export async function searchStats(days = 30) {
  const { safeDays, from } = windowStart(days);

  type KwRow = { keyword: string; cnt: bigint; zeroCnt: bigint; lastAt: Date };
  type TrendRow = { d: string; cnt: bigint };
  type UserRow = { userId: number; cnt: bigint; lastAt: Date };

  const [total, uniqueUsers, zeroResult, kwRows, trendRows, userRows] = await Promise.all([
    prisma.searchLog.count({ where: { createdAt: { gte: from } } }),
    // 人数只统计登录用户；游客没有 userId，混进来会让「人数」虚高
    prisma.searchLog.findMany({
      where: { createdAt: { gte: from }, userId: { not: null } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.searchLog.count({ where: { createdAt: { gte: from }, resultCount: 0 } }),
    prisma.$queryRaw<KwRow[]>(Prisma.sql`
      SELECT keyword,
             COUNT(*)                        AS cnt,
             SUM(CASE WHEN resultCount = 0 THEN 1 ELSE 0 END) AS zeroCnt,
             MAX(createdAt)                  AS lastAt
      FROM SearchLog
      WHERE createdAt >= ${from}
      GROUP BY keyword
      ORDER BY cnt DESC
      LIMIT 12
    `),
    prisma.$queryRaw<TrendRow[]>(Prisma.sql`
      SELECT ${localDayOf('createdAt')} AS d, COUNT(*) AS cnt
      FROM SearchLog
      WHERE createdAt >= ${from}
      GROUP BY ${localDayOf('createdAt')}
    `),
    prisma.$queryRaw<UserRow[]>(Prisma.sql`
      SELECT userId, COUNT(*) AS cnt, MAX(createdAt) AS lastAt
      FROM SearchLog
      WHERE createdAt >= ${from} AND userId IS NOT NULL
      GROUP BY userId
      ORDER BY cnt DESC
      LIMIT 20
    `),
  ]);

  const trendMap = new Map(trendRows.map((r) => [r.d, Number(r.cnt)]));
  const trend: { date: string; count: number }[] = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = dayKey(new Date(startOfToday().getTime() - i * 86400000));
    trend.push({ date: d, count: trendMap.get(d) ?? 0 });
  }

  const keywords = kwRows.map((r) => ({
    keyword: r.keyword,
    count: Number(r.cnt),
    zeroCount: Number(r.zeroCnt),
    lastAt: r.lastAt,
  }));

  // 每个用户「最后搜的那个词」单独取一次：数据量小（≤20 人），比窗口函数稳
  const userIds = userRows.map((r) => Number(r.userId));
  const [users, lastLogs] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, nickname: true, openid: true },
        })
      : Promise.resolve([]),
    Promise.all(
      userIds.map((id) =>
        prisma.searchLog.findFirst({
          where: { userId: id, createdAt: { gte: from } },
          orderBy: { createdAt: 'desc' },
          select: { keyword: true, createdAt: true, resultCount: true },
        })
      )
    ),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));

  return {
    days: safeDays,
    total,
    uniqueUsers: uniqueUsers.length,
    zeroResult,
    zeroRate: total > 0 ? Number(((zeroResult / total) * 100).toFixed(1)) : 0,
    // 热搜词
    topKeywords: keywords,
    // 搜了但没结果：按次数排，商家优先补这些
    zeroKeywords: keywords.filter((k) => k.zeroCount > 0).sort((a, b) => b.zeroCount - a.zeroCount),
    trend,
    // 按用户聚合：点进去看这个人的完整搜索记录
    users: userRows.map((r, i) => {
      const u = userMap.get(Number(r.userId));
      return {
        userId: Number(r.userId),
        nickname: u?.nickname ?? null,
        openid: u?.openid ?? '',
        count: Number(r.cnt),
        lastAt: r.lastAt,
        lastKeyword: lastLogs[i]?.keyword ?? '',
      };
    }),
  };
}

/**
 * 搜索明细：可按用户 / 关键词过滤，分页。
 * 「获取每一个用户的搜索记录」最终落到这个接口。
 */
export async function searchLogs(query: {
  days?: number;
  userId?: number;
  keyword?: string;
  page?: number;
  size?: number;
}) {
  const { safeDays, from } = windowStart(query.days ?? 30);
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(100, Math.max(1, query.size ?? 20));

  const where = {
    createdAt: { gte: from },
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.keyword ? { keyword: { contains: query.keyword } } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.searchLog.count({ where }),
    prisma.searchLog.findMany({
      where,
      include: { user: { select: { id: true, nickname: true, openid: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
    }),
  ]);

  return {
    days: safeDays,
    total,
    page,
    size,
    list: rows.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      resultCount: r.resultCount,
      createdAt: r.createdAt,
      user: r.user
        ? { id: r.user.id, nickname: r.user.nickname, openid: r.user.openid }
        : { id: null, nickname: null, openid: '' },
    })),
  };
}
