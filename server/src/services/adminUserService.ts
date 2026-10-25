import type { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { notFound } from '../utils/HttpError.js';

// 成交口径与 statsService 保持一致（PAID / SHIPPED / COMPLETED）
const PAID_STATUSES: OrderStatus[] = ['PAID', 'SHIPPED', 'COMPLETED'];

export interface AdminUserListQuery {
  keyword?: string;
  sort?: 'recent' | 'spend';
  page?: number;
  size?: number;
}

interface UserStat {
  orderCount: number;
  paidOrderCount: number;
  totalSpent: number;
  lastPaidAt: Date | null;
}

function buildWhere(keyword?: string): Prisma.UserWhereInput {
  const kw = keyword?.trim();
  if (!kw) return {};
  return {
    OR: [{ openid: { contains: kw } }, { nickname: { contains: kw } }, { phone: { contains: kw } }],
  };
}

// 批量取消费统计，避免逐个用户聚合造成 N+1
async function statsOf(userIds: number[]): Promise<Map<number, UserStat>> {
  const map = new Map<number, UserStat>();
  if (userIds.length === 0) return map;

  const [allCounts, paidAggs] = await Promise.all([
    prisma.order.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: { in: PAID_STATUSES } },
      _sum: { totalAmount: true },
      _count: { _all: true },
      _max: { paidAt: true },
    }),
  ]);

  for (const id of userIds) {
    map.set(id, { orderCount: 0, paidOrderCount: 0, totalSpent: 0, lastPaidAt: null });
  }
  for (const row of allCounts) {
    const s = map.get(row.userId);
    if (s) s.orderCount = row._count._all;
  }
  for (const row of paidAggs) {
    const s = map.get(row.userId);
    if (!s) continue;
    s.paidOrderCount = row._count._all;
    s.totalSpent = row._sum.totalAmount ?? 0;
    s.lastPaidAt = row._max.paidAt ?? null;
  }
  return map;
}

export async function listAdminUsers(query: AdminUserListQuery) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(100, Math.max(1, query.size ?? 20));
  const where = buildWhere(query.keyword);

  // 按消费额排序：先对成交订单聚合取 userId 顺序，再回查用户
  if (query.sort === 'spend') {
    const grouped = await prisma.order.groupBy({
      by: ['userId'],
      where: { status: { in: PAID_STATUSES } },
      _sum: { totalAmount: true },
      orderBy: { _sum: { totalAmount: 'desc' } },
      skip: (page - 1) * size,
      take: size,
    });
    const ids = grouped.map((g) => g.userId);
    const users = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids }, ...where },
          // C 端从不写 User.phone，真实联系方式在默认地址上
          include: { addresses: { where: { isDefault: true }, take: 1, select: { phone: true, receiverName: true } } },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const stats = await statsOf(users.map((u) => u.id));
    const total = await prisma.user.count({ where: { ...where, orders: { some: { status: { in: PAID_STATUSES } } } } });

    return {
      list: ids
        .map((id) => byId.get(id))
        .filter((u): u is NonNullable<typeof u> => Boolean(u))
        .map((u) => ({
          id: u.id,
          openid: u.openid,
          nickname: u.nickname,
          avatarUrl: u.avatarUrl,
          phone: u.phone ?? u.addresses[0]?.phone ?? null,
          receiverName: u.addresses[0]?.receiverName ?? null,
          createdAt: u.createdAt,
          ...(stats.get(u.id) ?? { orderCount: 0, paidOrderCount: 0, totalSpent: 0, lastPaidAt: null }),
        })),
      total,
      page,
      size,
    };
  }

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
      include: {
        _count: { select: { addresses: true } },
        addresses: { where: { isDefault: true }, take: 1, select: { phone: true, receiverName: true } },
      },
    }),
  ]);

  const stats = await statsOf(users.map((u) => u.id));
  return {
    list: users.map((u) => ({
      id: u.id,
      openid: u.openid,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      phone: u.phone ?? u.addresses[0]?.phone ?? null,
      receiverName: u.addresses[0]?.receiverName ?? null,
      createdAt: u.createdAt,
      addressCount: u._count.addresses,
      ...(stats.get(u.id) ?? { orderCount: 0, paidOrderCount: 0, totalSpent: 0, lastPaidAt: null }),
    })),
    total,
    page,
    size,
  };
}

export async function getAdminUserDetail(id: number) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { addresses: { orderBy: [{ isDefault: 'desc' }, { id: 'desc' }] } },
  });
  if (!user) throw notFound('用户不存在');

  const [stats, recentOrders] = await Promise.all([
    statsOf([id]),
    prisma.order.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { items: true },
    }),
  ]);

  const s = stats.get(id) ?? { orderCount: 0, paidOrderCount: 0, totalSpent: 0, lastPaidAt: null };

  return {
    id: user.id,
    openid: user.openid,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    createdAt: user.createdAt,
    ...s,
    avgOrderValue: s.paidOrderCount > 0 ? Math.round(s.totalSpent / s.paidOrderCount) : 0,
    addresses: user.addresses.map((a) => ({
      id: a.id,
      receiverName: a.receiverName,
      phone: a.phone,
      province: a.province,
      city: a.city,
      district: a.district,
      detail: a.detail,
      isDefault: a.isDefault,
    })),
    recentOrders: recentOrders.map((o) => ({
      orderNo: o.orderNo,
      status: o.status,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      itemCount: o.items.length,
      goodsSummary: o.items.length
        ? `${o.items[0].productName}${o.items.length > 1 ? ` 等 ${o.items.length} 种` : ''}`
        : '',
    })),
  };
}
