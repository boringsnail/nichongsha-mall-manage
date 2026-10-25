import { prisma } from '../db.js';
import { badRequest, notFound, orderIllegal } from '../utils/HttpError.js';
import { secureRandomFour } from '../auth/jwt.js';
import { executeRefund, markRefunded, markRefundRetryable, markRefundManual } from './refundService.js';

// 售后体系（对齐淘宝）：
//
//   ┌─ 仅退款（REFUND_ONLY）────────────────────────────────────────┐
//   │  未收到货 / 未发货 / 物流停滞 → 用户申请 → 商家同意 → 原路退款   │
//   └───────────────────────────────────────────────────────────────┘
//
//   ┌─ 退货退款（RETURN_REFUND）────────────────────────────────────┐
//   │  已收到货 → 用户申请 → 商家同意 → 用户寄回并填单号              │
//   │            → 商家确认收货 → 原路退款                            │
//   └───────────────────────────────────────────────────────────────┘
//
// 状态机（只前进，拒绝/撤销是终态）：
//
//   REFUND_ONLY  : PENDING → AGREED → REFUNDING → COMPLETED
//   RETURN_REFUND: PENDING → WAIT_RETURN → RETURNING → REFUNDING → COMPLETED
//   PENDING → REJECTED（商家拒绝）；PENDING/AGREED/WAIT_RETURN → CANCELLED（用户撤销）
//
// 并发控制：所有状态迁移用 updateMany + 期望状态做条件，抢不到即「状态已变化」，天然防重。

/** 售后申请原因（值与小程序展示文案一一对应，改文案不用改数据） */
export const AFTER_SALE_REASONS = {
  // 仅退款
  NOT_SHIPPED: '商家未发货',
  LOGISTICS_STUCK: '物流一直未更新',
  LOGISTICS_ABNORMAL: '物流显示已签收但未收到',
  WRONG_ITEM: '商品发错了',
  DAMAGED: '商品破损/少件',
  QUALITY: '质量问题',
  NO_LONGER_NEEDED: '不想要了',
  // 退货退款
  SEVEN_DAY: '七天无理由退货',
  SIZE_MISMATCH: '尺寸/规格不合适',
  NOT_AS_DESCRIBED: '与描述不符',
  OTHER: '其他原因',
} as const;

export type AfterSaleReason = keyof typeof AFTER_SALE_REASONS;

/**
 * 各原因允许的售后类型。
 * 淘宝的规则：货还没到手，只能选「仅退款」；已经签收，通常走「退货退款」。
 * 但「质量问题/破损」这类允许仅退款（商家认损，不必寄回）。
 */
const REASON_ALLOWED_TYPES: Record<AfterSaleReason, Array<'REFUND_ONLY' | 'RETURN_REFUND'>> = {
  NOT_SHIPPED: ['REFUND_ONLY'],
  LOGISTICS_STUCK: ['REFUND_ONLY'],
  LOGISTICS_ABNORMAL: ['REFUND_ONLY', 'RETURN_REFUND'],
  WRONG_ITEM: ['REFUND_ONLY', 'RETURN_REFUND'],
  DAMAGED: ['REFUND_ONLY', 'RETURN_REFUND'],
  QUALITY: ['REFUND_ONLY', 'RETURN_REFUND'],
  NO_LONGER_NEEDED: ['REFUND_ONLY', 'RETURN_REFUND'],
  SEVEN_DAY: ['RETURN_REFUND'],
  SIZE_MISMATCH: ['RETURN_REFUND'],
  NOT_AS_DESCRIBED: ['RETURN_REFUND'],
  OTHER: ['REFUND_ONLY', 'RETURN_REFUND'],
};

/** 处于「在途」的售后状态：同一订单同时只允许一笔，避免重复退款 */
const ACTIVE_STATUSES = ['PENDING', 'AGREED', 'WAIT_RETURN', 'RETURNING', 'REFUNDING'] as const;

/** Prisma 的 in 需要枚举数组，这里集中转换一次，避免处处 as never */
function activeStatuses(): Array<import('@prisma/client').AfterSaleStatus> {
  return ACTIVE_STATUSES as unknown as Array<import('@prisma/client').AfterSaleStatus>;
}

/** 可以发起售后的订单状态（待付款不能申请，取消/已完成视情况） */
const AFTER_SALE_ALLOWED_ORDER_STATUS = ['PAID', 'SHIPPED', 'COMPLETED'];

function genAfterSaleNo(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const t = `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `AS${t}${secureRandomFour()}`;
}

function parseImages(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** 对外输出：把枚举翻译成小程序直接可用的结构 */
export function toAfterSaleView(
  row: {
    afterSaleNo: string;
    orderNo: string;
    type: string;
    status: string;
    reason: string;
    description: string | null;
    images: string;
    refundAmount: number;
    refundedAmount: number;
    refundNo: string | null;
    rejectReason: string | null;
    returnLogisticsCompany: string | null;
    returnTrackingNo: string | null;
    agreedAt: Date | null;
    returnedAt: Date | null;
    receivedAt: Date | null;
    refundedAt: Date | null;
    rejectedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
  },
  extra: {
    orderTotal?: number;
    orderStatus?: string;
    items?: unknown[];
    user?: { openid: string; nickname: string | null };
  } = {},
) {
  return {
    afterSaleNo: row.afterSaleNo,
    orderNo: row.orderNo,
    type: row.type,
    status: row.status,
    reason: row.reason,
    reasonText: AFTER_SALE_REASONS[row.reason as AfterSaleReason] ?? row.reason,
    description: row.description,
    images: parseImages(row.images),
    refundAmount: row.refundAmount,
    refundedAmount: row.refundedAmount,
    refundNo: row.refundNo,
    rejectReason: row.rejectReason,
    returnLogisticsCompany: row.returnLogisticsCompany,
    returnTrackingNo: row.returnTrackingNo,
    agreedAt: row.agreedAt,
    returnedAt: row.returnedAt,
    receivedAt: row.receivedAt,
    refundedAt: row.refundedAt,
    rejectedAt: row.rejectedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    ...extra,
  };
}

/** 可申请售后的金额上限：订单实付 - 已退金额 */
function refundableAmount(order: { totalAmount: number; refundedAmount: number }): number {
  return Math.max(0, order.totalAmount - order.refundedAmount);
}

/**
 * 申请售后。
 *
 * 校验顺序刻意从严到宽（先便宜后贵），并在建单前用事务复查「在途售后」，
 * 避免用户连点两次建出两笔售后 → 退两次钱。
 */
export async function applyAfterSale(
  uid: number,
  input: {
    orderNo: string;
    type: 'REFUND_ONLY' | 'RETURN_REFUND';
    reason: string;
    description?: string;
    images?: string[];
    refundAmount?: number;
  },
) {
  const order = await prisma.order.findFirst({ where: { orderNo: input.orderNo, userId: uid }, include: { items: true } });
  if (!order) throw notFound('订单不存在');

  if (!AFTER_SALE_ALLOWED_ORDER_STATUS.includes(order.status)) {
    throw orderIllegal(
      order.status === 'PENDING_PAYMENT' ? '订单还未支付，无需申请售后' : '该订单当前状态不支持申请售后',
    );
  }

  const reason = input.reason as AfterSaleReason;
  if (!AFTER_SALE_REASONS[reason]) throw badRequest('PARAM_ERROR', '请选择售后原因');
  const allowedTypes = REASON_ALLOWED_TYPES[reason] ?? ['REFUND_ONLY', 'RETURN_REFUND'];
  if (!allowedTypes.includes(input.type)) {
    throw badRequest(
      'PARAM_ERROR',
      input.type === 'RETURN_REFUND' ? '该原因不支持退货退款' : '该原因需要寄回商品，请选择退货退款',
    );
  }

  // 仅退款：货还没到手（待发货/待收货）才合理；已完成的订单要走退货退款
  if (input.type === 'REFUND_ONLY' && order.status === 'COMPLETED' && reason !== 'QUALITY' && reason !== 'DAMAGED') {
    throw orderIllegal('订单已完成，如需退款请选择退货退款');
  }

  const maxRefund = refundableAmount(order);
  if (maxRefund <= 0) throw orderIllegal('该订单已全额退款，无需重复申请');

  const images = (input.images ?? []).filter((u) => typeof u === 'string' && u.length > 0).slice(0, 6);
  const refundAmount = input.refundAmount == null ? maxRefund : Math.round(input.refundAmount);
  if (!Number.isInteger(refundAmount) || refundAmount <= 0) throw badRequest('PARAM_ERROR', '退款金额必须大于 0');
  if (refundAmount > maxRefund) {
    throw badRequest('PARAM_ERROR', `退款金额不能超过可退金额 ¥${(maxRefund / 100).toFixed(2)}`);
  }

  // 在途售后互斥 + 建单，放在同一事务里复查
  return prisma.$transaction(async (tx) => {
    const inFlight = await tx.afterSale.findFirst({
      where: { orderId: order.id, status: { in: activeStatuses() } },
      select: { afterSaleNo: true, status: true },
    });
    if (inFlight) {
      throw orderIllegal(`该订单已有进行中的售后（${inFlight.afterSaleNo}），请先处理完再申请`);
    }

    const created = await tx.afterSale.create({
      data: {
        afterSaleNo: genAfterSaleNo(),
        orderId: order.id,
        orderNo: order.orderNo,
        userId: uid,
        type: input.type,
        reason,
        description: input.description?.trim() || null,
        images: JSON.stringify(images),
        refundAmount,
      },
    });
    await tx.order.update({ where: { id: order.id }, data: { afterSaleStatus: 'PENDING' } });
    console.log(
      `[after-sale] 用户申请售后 ${created.afterSaleNo} 订单=${order.orderNo} 类型=${input.type} 金额=${refundAmount}`,
    );
    return toAfterSaleView(created, { orderTotal: order.totalAmount, orderStatus: order.status });
  });
}

export async function listMyAfterSales(uid: number, query: { page?: number; size?: number }) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 10));
  const [total, rows] = await Promise.all([
    prisma.afterSale.count({ where: { userId: uid } }),
    prisma.afterSale.findMany({
      where: { userId: uid },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
      include: { order: { include: { items: true } } },
    }),
  ]);
  return {
    list: rows.map((r) =>
      toAfterSaleView(r, {
        orderTotal: r.order.totalAmount,
        orderStatus: r.order.status,
        items: r.order.items.map((i) => ({
          productName: i.productName,
          specName: i.specName,
          coverImage: i.coverImage,
          price: i.price,
          quantity: i.quantity,
        })),
      }),
    ),
    total,
    page,
    size,
  };
}

export async function getMyAfterSale(uid: number, afterSaleNo: string) {
  const row = await prisma.afterSale.findFirst({
    where: { afterSaleNo, userId: uid },
    include: { order: { include: { items: true } } },
  });
  if (!row) throw notFound('售后单不存在');
  return toAfterSaleView(row, {
    orderTotal: row.order.totalAmount,
    orderStatus: row.order.status,
    items: row.order.items.map((i) => ({
      productName: i.productName,
      specName: i.specName,
      coverImage: i.coverImage,
      price: i.price,
      quantity: i.quantity,
    })),
  });
}

/** 买家撤销售后：仅 PENDING / AGREED / WAIT_RETURN / RETURNING 可撤销（已提交退款不能撤） */
export async function cancelAfterSale(uid: number, afterSaleNo: string, reason?: string) {
  const row = await prisma.afterSale.findFirst({ where: { afterSaleNo, userId: uid } });
  if (!row) throw notFound('售后单不存在');
  if (row.status === 'REFUNDING') throw orderIllegal('退款已提交，无法撤销');
  if (row.status === 'COMPLETED') throw orderIllegal('售后已完成，无法撤销');
  if (row.status === 'CANCELLED') throw orderIllegal('售后已撤销');
  if (row.status === 'REJECTED') throw orderIllegal('售后已被拒绝，无法撤销');

  const updated = await prisma.afterSale.updateMany({
    where: { afterSaleNo, status: { in: ['PENDING', 'AGREED', 'WAIT_RETURN', 'RETURNING'] } },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      description: reason ? `${row.description ? row.description + '；' : ''}买家撤销：${reason}` : row.description,
    },
  });
  if (updated.count !== 1) throw orderIllegal('售后状态已变化，请刷新后重试');
  await syncOrderAfterSaleStatus(row.orderId);
  console.log(`[after-sale] 买家撤销 ${afterSaleNo}`);
  return getMyAfterSale(uid, afterSaleNo);
}

/** 买家填写退货物流单号（仅退货退款、状态为待退货时） */
export async function submitReturnTracking(
  uid: number,
  afterSaleNo: string,
  input: { logisticsCompany: string; trackingNo: string },
) {
  const row = await prisma.afterSale.findFirst({ where: { afterSaleNo, userId: uid } });
  if (!row) throw notFound('售后单不存在');
  if (row.type !== 'RETURN_REFUND') throw orderIllegal('该售后无需寄回商品');
  if (row.status !== 'WAIT_RETURN') {
    throw orderIllegal(row.status === 'RETURNING' ? '退货单号已提交' : '当前状态不能提交退货单号');
  }
  const company = input.logisticsCompany.trim();
  const trackingNo = input.trackingNo.trim();
  if (!company || !trackingNo) throw badRequest('PARAM_ERROR', '请填写快递公司和运单号');

  const updated = await prisma.afterSale.updateMany({
    where: { afterSaleNo, status: 'WAIT_RETURN' },
    data: {
      status: 'RETURNING',
      returnLogisticsCompany: company,
      returnTrackingNo: trackingNo,
      returnedAt: new Date(),
    },
  });
  if (updated.count !== 1) throw orderIllegal('售后状态已变化，请刷新后重试');
  await syncOrderAfterSaleStatus(row.orderId);
  console.log(`[after-sale] 买家已退货 ${afterSaleNo} ${company}/${trackingNo}`);
  return getMyAfterSale(uid, afterSaleNo);
}

// ---------- 商家侧 ----------

export async function listAdminAfterSales(query: {
  status?: string;
  keyword?: string;
  page?: number;
  size?: number;
}) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 20));
  const keyword = query.keyword?.trim();
  const where = {
    ...(query.status ? { status: query.status as never } : {}),
    // 商家最常用的两个检索入口：售后单号、订单号。都是精确/前缀可命中的短串，
    // 用 contains 足够，不必上全文索引。
    ...(keyword ? { OR: [{ afterSaleNo: { contains: keyword } }, { orderNo: { contains: keyword } }] } : {}),
  };
  const [total, rows, grouped] = await Promise.all([
    prisma.afterSale.count({ where }),
    prisma.afterSale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
      include: { order: { include: { items: true, user: true } } },
    }),
    // 各状态的总数：标签页上直接显示「待处理 3」，商家一眼知道有没有活要干。
    // 这里刻意不带 where，统计的是全量而非当前筛选结果。
    prisma.afterSale.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  return {
    list: rows.map((r) =>
      toAfterSaleView(r, {
        orderTotal: r.order.totalAmount,
        orderStatus: r.order.status,
        user: { openid: r.order.user.openid, nickname: r.order.user.nickname },
        items: r.order.items.map((i) => ({
          productName: i.productName,
          specName: i.specName,
          coverImage: i.coverImage,
          price: i.price,
          quantity: i.quantity,
        })),
      }),
    ),
    total,
    page,
    size,
    /** 各状态数量（全量口径），供管控台标签页显示待办数 */
    counts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Record<string, number>,
    // 把「超时自动同意/自动关闭」的规则带回前端，管控台才能准确显示倒计时，
    // 而不是在界面上硬编码 48 小时（实际由环境变量控制）
    reviewHours: afterSaleReviewHours(),
    returnDays: afterSaleReturnDays(),
  };
}

export async function getAdminAfterSale(afterSaleNo: string) {
  const row = await prisma.afterSale.findUnique({
    where: { afterSaleNo },
    include: { order: { include: { items: true, user: true } } },
  });
  if (!row) throw notFound('售后单不存在');
  return toAfterSaleView(row, {
    orderTotal: row.order.totalAmount,
    orderStatus: row.order.status,
    user: { openid: row.order.user.openid, nickname: row.order.user.nickname },
    items: row.order.items.map((i) => ({
      productName: i.productName,
      specName: i.specName,
      coverImage: i.coverImage,
      price: i.price,
      quantity: i.quantity,
    })),
  });
}

/**
 * 商家同意售后。
 *  - 仅退款 → 直接发起退款，进入 REFUNDING
 *  - 退货退款 → 进入 WAIT_RETURN，等买家寄回
 *
 * 退款是「钱出去」的动作，因此放在状态迁移成功之后才执行：
 * 若退款失败且可重试，售后单退回 AGREED，用户/商家可以再点一次；
 * 若需要人工（如超额、账户异常），保持 REFUNDING 并打告警日志。
 */
export async function approveAfterSale(afterSaleNo: string) {
  const row = await prisma.afterSale.findUnique({ where: { afterSaleNo }, include: { order: true } });
  if (!row) throw notFound('售后单不存在');
  if (row.status !== 'PENDING') throw orderIllegal('仅待处理的售后可以同意');

  const nextStatus = row.type === 'REFUND_ONLY' ? 'AGREED' : 'WAIT_RETURN';
  const updated = await prisma.afterSale.updateMany({
    where: { afterSaleNo, status: 'PENDING' },
    data: { status: nextStatus, agreedAt: new Date() },
  });
  if (updated.count !== 1) throw orderIllegal('售后状态已变化，请刷新后重试');
  await syncOrderAfterSaleStatus(row.orderId);
  console.log(`[after-sale] 商家同意 ${afterSaleNo} → ${nextStatus}`);

  // 仅退款：同意即退款
  if (row.type === 'REFUND_ONLY') {
    await runRefund(afterSaleNo);
  }
  return getAdminAfterSale(afterSaleNo);
}

/** 商家拒绝售后 */
export async function rejectAfterSale(afterSaleNo: string, reason: string) {
  const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
  if (!row) throw notFound('售后单不存在');
  if (row.status !== 'PENDING') throw orderIllegal('仅待处理的售后可以拒绝');
  const text = reason.trim();
  if (!text) throw badRequest('PARAM_ERROR', '请填写拒绝原因');

  const updated = await prisma.afterSale.updateMany({
    where: { afterSaleNo, status: 'PENDING' },
    data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: text.slice(0, 256) },
  });
  if (updated.count !== 1) throw orderIllegal('售后状态已变化，请刷新后重试');
  await syncOrderAfterSaleStatus(row.orderId);
  console.log(`[after-sale] 商家拒绝 ${afterSaleNo}: ${text}`);
  return getAdminAfterSale(afterSaleNo);
}

/** 商家确认收到退货并退款（仅退货退款、状态为已退货时） */
export async function confirmReturnReceived(afterSaleNo: string) {
  const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
  if (!row) throw notFound('售后单不存在');
  if (row.type !== 'RETURN_REFUND') throw orderIllegal('该售后不是退货退款');
  if (row.status !== 'RETURNING') throw orderIllegal('买家还未寄回商品');

  const updated = await prisma.afterSale.updateMany({
    where: { afterSaleNo, status: 'RETURNING' },
    data: { status: 'AGREED', receivedAt: new Date() },
  });
  if (updated.count !== 1) throw orderIllegal('售后状态已变化，请刷新后重试');
  console.log(`[after-sale] 商家确认收到退货 ${afterSaleNo}`);

  await runRefund(afterSaleNo);
  return getAdminAfterSale(afterSaleNo);
}

/**
 * 执行退款（内部）：把售后单推进到 REFUNDING 再调微信，成功/处理中都算受理。
 * 失败按「能否重试」分流，绝不把售后单留在半路。
 */
async function runRefund(afterSaleNo: string): Promise<void> {
  const row = await prisma.afterSale.findUnique({ where: { afterSaleNo }, include: { order: true } });
  if (!row) throw notFound('售后单不存在');
  if (row.status === 'REFUNDING' || row.status === 'COMPLETED') return;

  const moved = await prisma.afterSale.updateMany({
    where: { afterSaleNo, status: { in: ['AGREED', 'RETURNING', 'WAIT_RETURN'] } },
    data: { status: 'REFUNDING' },
  });
  if (moved.count !== 1) {
    console.warn(`[after-sale] 退款前置状态迁移失败，跳过 ${afterSaleNo}（当前 ${row.status}）`);
    return;
  }
  await syncOrderAfterSaleStatus(row.orderId);

  const outcome = await executeRefund({
    orderNo: row.orderNo,
    afterSaleNo,
    totalFee: row.order.totalAmount,
    refundFee: row.refundAmount,
    alreadyRefunded: row.order.refundedAmount,
    reason: `售后 ${afterSaleNo}`,
  });

  if (outcome.ok) {
    // SUCCESS 直接落库；PROCESSING 等回调，但先把微信退款单号记下来
    if (outcome.status === 'SUCCESS') {
      await markRefunded(afterSaleNo, { refundNo: outcome.refundNo, refundFee: row.refundAmount });
    } else {
      await prisma.afterSale.update({ where: { afterSaleNo }, data: { refundNo: outcome.refundNo } });
      console.log(`[after-sale] 退款处理中，等待微信回调 ${afterSaleNo}`);
    }
    return;
  }

  if (outcome.needsManual) {
    await markRefundManual(afterSaleNo, outcome.error);
    return;
  }
  await markRefundRetryable(afterSaleNo, outcome.error);
}

/** 把订单维度的 afterSaleStatus 刷新为「最新一笔售后」的状态，供列表页直接展示 */
export async function syncOrderAfterSaleStatus(orderId: number): Promise<void> {
  const latest = await prisma.afterSale.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { status: true },
  });
  await prisma.order.update({
    where: { id: orderId },
    data: { afterSaleStatus: latest?.status ?? null },
  });
}

/**
 * 买家「确认收货」前置校验：有在途售后时不允许确认收货。
 * 否则用户可以在退货途中先确认收货，把订单锁成已完成，售后金额校验会变复杂。
 */
export async function hasActiveAfterSale(orderId: number): Promise<boolean> {
  const n = await prisma.afterSale.count({
    where: { orderId, status: { in: activeStatuses() } },
  });
  return n > 0;
}

// ---------- 超时自动处理（淘宝规则） ----------

/** 商家处理售后的时限（小时），默认 48。环境变量 AFTER_SALE_REVIEW_HOURS */
export function afterSaleReviewHours(): number {
  const n = Number(process.env.AFTER_SALE_REVIEW_HOURS ?? 48);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

/** 买家寄回商品的时限（天），默认 7。环境变量 AFTER_SALE_RETURN_DAYS */
export function afterSaleReturnDays(): number {
  const n = Number(process.env.AFTER_SALE_RETURN_DAYS ?? 7);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/**
 * 售后超时自动流转：
 *
 *  1. PENDING 超过 N 小时商家没处理 → 自动同意（淘宝的「超时未处理默认同意」）。
 *     否则用户申请完就石沉大海，只能找客服；而这笔售后会一直挂在「待处理」。
 *  2. WAIT_RETURN 超过 N 天买家没寄回 → 自动关闭（淘宝是「超时未退货，售后关闭」）。
 *     一直不关，用户还能随时补寄，商家永远不知道该不该备货。
 *
 * 自动同意会真的触发退款（仅退款类型），因此这条路径必须同样严谨：
 * 走 approveAfterSale 而不是直接改状态，复用同一套金额校验与幂等退款。
 */
export async function autoProgressAfterSales(limit = 50): Promise<number> {
  const now = Date.now();
  const reviewDeadline = new Date(now - afterSaleReviewHours() * 60 * 60 * 1000);
  const returnDeadline = new Date(now - afterSaleReturnDays() * 24 * 60 * 60 * 1000);

  const stale = await prisma.afterSale.findMany({
    where: {
      OR: [
        { status: 'PENDING', createdAt: { lte: reviewDeadline } },
        { status: 'WAIT_RETURN', agreedAt: { lte: returnDeadline } },
      ],
    },
    select: { afterSaleNo: true, status: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let handled = 0;
  for (const row of stale) {
    try {
      if (row.status === 'PENDING') {
        console.log(`[after-sale] 商家超时未处理，自动同意 ${row.afterSaleNo}`);
        await approveAfterSale(row.afterSaleNo);
        handled += 1;
      } else if (row.status === 'WAIT_RETURN') {
        const updated = await prisma.afterSale.updateMany({
          where: { afterSaleNo: row.afterSaleNo, status: 'WAIT_RETURN' },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            rejectReason: `超时未寄回商品（${afterSaleReturnDays()} 天），售后自动关闭`,
          },
        });
        if (updated.count) {
          console.log(`[after-sale] 买家超时未退货，售后自动关闭 ${row.afterSaleNo}`);
          const fresh = await prisma.afterSale.findUnique({ where: { afterSaleNo: row.afterSaleNo } });
          if (fresh) await syncOrderAfterSaleStatus(fresh.orderId);
          handled += 1;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 单笔失败不影响其它单（例如并发下已被人工处理）
      console.warn(`[after-sale] 自动处理失败 ${row.afterSaleNo}: ${reason}`);
    }
  }
  return handled;
}

/**
 * 退款状态对账：把卡在 REFUNDING 的售后单主动查一次微信。
 * 退款回调可能丢失（网络/验签配置变更），不查就会永远显示「退款中」。
 */
export async function reconcileRefundingAfterSales(limit = 30): Promise<number> {
  const rows = await prisma.afterSale.findMany({
    where: { status: 'REFUNDING' },
    select: { afterSaleNo: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  if (!rows.length) return 0;

  const { probeRefund } = await import('./refundService.js');
  let fixed = 0;
  for (const row of rows) {
    const res = await probeRefund(row.afterSaleNo);
    if (!res.ok || res.status !== 'SUCCESS') continue;
    const done = await markRefunded(row.afterSaleNo, {});
    if (done.changed) {
      console.log(`[after-sale] 主动查退款补落成功 ${row.afterSaleNo}`);
      fixed += 1;
    }
  }
  return fixed;
}
