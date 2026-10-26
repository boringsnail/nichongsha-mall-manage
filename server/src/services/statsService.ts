import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';

const PAID_STATUSES = ['PAID', 'SHIPPED', 'COMPLETED'];

// 本地时区当天 0 点
function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// GMV/销量/订单数：全部走 SQL 聚合，避免把明细行拉进内存
async function gmvStats(from: Date, to: Date) {
  const where = { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: from, lte: to } };
  const [gmvAgg, salesAgg, orderCount] = await Promise.all([
    prisma.order.aggregate({ where, _sum: { totalAmount: true } }),
    prisma.orderItem.aggregate({
      where: { order: { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: from, lte: to } } },
      _sum: { quantity: true },
    }),
    prisma.order.count({ where }),
  ]);
  return { gmv: gmvAgg._sum.totalAmount ?? 0, salesCount: salesAgg._sum.quantity ?? 0, orderCount };
}

export async function overview() {
  const todayStart = startOfToday();
  const now = new Date();
  const weekStart = new Date(todayStart.getTime() - 6 * 86400000);

  const [today, week, toShip, lowStockCount, todayOrders] = await Promise.all([
    gmvStats(todayStart, now),
    gmvStats(weekStart, now),
    prisma.order.count({ where: { status: 'PAID' } }),
    prisma.sku.count({ where: { stock: { lte: 10 } } }),
    prisma.order.count({ where: { createdAt: { gte: todayStart } } }),
  ]);
  today.orderCount = todayOrders;

  return { today, week, toShip, lowStockCount };
}

// 最近 N 天已支付商品的销量/GMV 排行
//
// 改成 SQL 聚合：一年（365 天）的明细可能有几万行，拉进内存再分组既慢又费内存；
// 这里直接 GROUP BY 让 MySQL 出结果，limit 也交给它。
export async function topProducts(days = 7, limit = 10) {
  const safeDays = Math.min(Math.max(days, 1), 365);
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const from = new Date(startOfToday().getTime() - (safeDays - 1) * 86400000);

  type Row = {
    productId: number;
    name: string;
    coverImage: string | null;
    status: string | null;
    salesCount: bigint;
    gmv: bigint;
    orderCount: bigint;
  };
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT i.productId                                              AS productId,
           MAX(i.productName)                                       AS name,
           MAX(p.coverImage)                                        AS coverImage,
           MAX(p.status)                                            AS status,
           COALESCE(SUM(i.quantity), 0)                             AS salesCount,
           COALESCE(SUM(i.price * i.quantity), 0)                   AS gmv,
           COUNT(DISTINCT i.orderId)                                AS orderCount
    FROM OrderItem i
    JOIN \`Order\` o ON o.id = i.orderId
    LEFT JOIN Product p ON p.id = i.productId
    WHERE o.status IN ('PAID','SHIPPED','COMPLETED') AND o.paidAt >= ${from}
    GROUP BY i.productId
    ORDER BY salesCount DESC, gmv DESC
    LIMIT ${safeLimit}
  `);

  return rows.map((r, idx) => ({
    rank: idx + 1,
    productId: Number(r.productId),
    name: r.name,
    coverImage: r.coverImage ?? '',
    status: r.status ?? 'OFF',
    salesCount: Number(r.salesCount),
    gmv: Number(r.gmv),
    orderCount: Number(r.orderCount),
  }));
}

/**
 * 单个商品在 N 天内的每日售卖趋势（销量 + GMV）
 * 点开 TOP N 的某一行看的就是这个。
 */
export async function productTrend(productId: number, days = 30) {
  const safeDays = Math.min(Math.max(days, 1), 365);
  const today = startOfToday();
  const from = new Date(today.getTime() - (safeDays - 1) * 86400000);

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, coverImage: true, status: true, salesCount: true },
  });
  if (!product) return null;

  type Row = { d: string; qty: bigint; gmv: bigint; orders: bigint };
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${localDayOf('o.paidAt')}                AS d,
           COALESCE(SUM(i.quantity), 0)             AS qty,
           COALESCE(SUM(i.price * i.quantity), 0)   AS gmv,
           COUNT(DISTINCT i.orderId)                AS orders
    FROM OrderItem i
    JOIN \`Order\` o ON o.id = i.orderId
    WHERE i.productId = ${productId}
      AND o.status IN ('PAID','SHIPPED','COMPLETED')
      AND o.paidAt >= ${from}
    GROUP BY ${localDayOf('o.paidAt')}
  `);
  const map = new Map(rows.map((r) => [r.d, r]));

  const points: { date: string; salesCount: number; gmv: number; orderCount: number }[] = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = dayKey(new Date(today.getTime() - i * 86400000));
    const hit = map.get(d);
    points.push({
      date: d,
      salesCount: hit ? Number(hit.qty) : 0,
      gmv: hit ? Number(hit.gmv) : 0,
      orderCount: hit ? Number(hit.orders) : 0,
    });
  }

  return {
    productId: product.id,
    name: product.name,
    coverImage: product.coverImage,
    status: product.status,
    // 建品以来的累计销量，用来和窗口内销量对比（判断是爆款还是刚起量）
    lifetimeSales: product.salesCount,
    days: safeDays,
    totalSales: points.reduce((s, p) => s + p.salesCount, 0),
    totalGmv: points.reduce((s, p) => s + p.gmv, 0),
    orderCount: points.reduce((s, p) => s + p.orderCount, 0),
    points,
  };
}

/**
 * 营收口径（商家最关心的三个数）
 *
 *   总营业额 gross  = Σ 订单实付金额（商品 + 顾客付的运费）
 *   配送成本 deliveryCost = Σ 我们付给骑手/快递的钱（商家在订单里录的）
 *   退款 refund     = Σ 订单已退金额
 *   净营业额 net    = gross − refund − deliveryCost
 *
 * 只统计「已支付/已发货/已完成」且 paidAt 落在窗口内的订单，
 * 这样 gross 与 refund 是同一批订单的口径，减出来才有意义。
 */
export async function revenue(days = 30) {
  const safeDays = Math.min(Math.max(days, 1), 365);
  const from = new Date(startOfToday().getTime() - (safeDays - 1) * 86400000);

  const agg = await prisma.order.aggregate({
    where: { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: from } },
    _sum: { totalAmount: true, freight: true, deliveryCost: true, refundedAmount: true },
    _count: { _all: true },
  });

  const gross = agg._sum.totalAmount ?? 0;
  const freight = agg._sum.freight ?? 0;
  const deliveryCost = agg._sum.deliveryCost ?? 0;
  const refund = agg._sum.refundedAmount ?? 0;
  const orderCount = agg._count._all;
  const net = gross - refund - deliveryCost;

  return {
    days: safeDays,
    gross,
    // 顾客付的运费（已含在 gross 里，单独拆出来便于核对）
    freight,
    deliveryCost,
    refund,
    net,
    orderCount,
    // 客单价与净利率：口径固定成整数分，前端只负责除以 100
    aov: orderCount > 0 ? Math.round(gross / orderCount) : 0,
    netRate: gross > 0 ? Number(((net / gross) * 100).toFixed(1)) : 0,
    // 有多少单还没录配送成本：提示商家去补，否则净额会偏高
    missingDeliveryCost: await prisma.order.count({
      where: {
        status: { in: PAID_STATUSES as never[] },
        paidAt: { gte: from },
        deliveryCost: 0,
      },
    }),
  };
}


// 低库存预警：stock ≤ threshold
export async function lowStock(threshold = 10) {
  const skus = await prisma.sku.findMany({
    where: { stock: { lte: threshold } },
    include: { product: true },
    orderBy: { stock: 'asc' },
  });
  return skus.map((s) => ({ skuId: s.id, productName: s.product.name, specName: s.specName, stock: s.stock }));
}

// 把 Date 转成本地时区的 yyyy-MM-dd（与 startOfToday 同口径，避免 UTC 偏移串天）
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Prisma 将 DateTime 以 UTC 存入 MySQL，而展示桶是按本地日期生成的。
// SQL 里若直接 DATE_FORMAT(paidAt) 会按 UTC 归集，导致本地 00:00–08:00 的数据串到前一天
// （现象：凌晨时段「今日 GMV」为 0）。因此显式换算到业务时区，可用 STATS_TZ_OFFSET 覆盖。
// 注意：偏移量必须**内联为字面量**——用 ? 占位符时 MySQL 的 only_full_group_by 会认为
// SELECT 与 GROUP BY 里的表达式不是同一个，直接报 1055。
const STATS_TZ_OFFSET = /^[+-]\d{2}:\d{2}$/.test(process.env.STATS_TZ_OFFSET ?? '')
  ? (process.env.STATS_TZ_OFFSET as string)
  : '+08:00';

/** 把 UTC 存储的 datetime 列换算成本地日期字符串的 SQL 片段 */
function localDayOf(column: string) {
  return Prisma.sql`DATE_FORMAT(CONVERT_TZ(${Prisma.raw(column)}, '+00:00', ${Prisma.raw(`'${STATS_TZ_OFFSET}'`)}), '%Y-%m-%d')`;
}

/**
 * 近 N 天每日趋势（GMV / 订单数 / 销量）
 * 用 SQL 按天聚合而非拉明细进内存；缺失日期补 0，保证前端折线连续。
 */
export async function trend(days = 30) {
  const safeDays = Math.min(Math.max(days, 1), 90);
  const today = startOfToday();
  const from = new Date(today.getTime() - (safeDays - 1) * 86400000);

  type OrderRow = { d: string; gmv: bigint; orders: bigint; delivery: bigint; refund: bigint };
  type SaleRow = { d: string; sales: bigint };

  const [orderRows, saleRows] = await Promise.all([
    prisma.$queryRaw<OrderRow[]>(Prisma.sql`
      SELECT ${localDayOf('paidAt')} AS d,
             COALESCE(SUM(totalAmount), 0) AS gmv,
             COUNT(*) AS orders,
             COALESCE(SUM(deliveryCost), 0) AS delivery,
             COALESCE(SUM(refundedAmount), 0) AS refund
      FROM \`Order\`
      WHERE status IN ('PAID','SHIPPED','COMPLETED') AND paidAt >= ${from}
      GROUP BY ${localDayOf('paidAt')}
    `),
    prisma.$queryRaw<SaleRow[]>(Prisma.sql`
      SELECT ${localDayOf('o.paidAt')} AS d,
             COALESCE(SUM(i.quantity), 0) AS sales
      FROM OrderItem i
      JOIN \`Order\` o ON o.id = i.orderId
      WHERE o.status IN ('PAID','SHIPPED','COMPLETED') AND o.paidAt >= ${from}
      GROUP BY ${localDayOf('o.paidAt')}
    `),
  ]);

  const gmvMap = new Map(
    orderRows.map((r) => [
      r.d,
      {
        gmv: Number(r.gmv),
        orders: Number(r.orders),
        deliveryCost: Number(r.delivery),
        refund: Number(r.refund),
      },
    ])
  );
  const saleMap = new Map(saleRows.map((r) => [r.d, Number(r.sales)]));

  const out: {
    date: string;
    gmv: number;
    orderCount: number;
    salesCount: number;
    deliveryCost: number;
    refund: number;
    net: number;
  }[] = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = dayKey(new Date(today.getTime() - i * 86400000));
    const hit = gmvMap.get(d);
    const gmv = hit?.gmv ?? 0;
    const deliveryCost = hit?.deliveryCost ?? 0;
    const refund = hit?.refund ?? 0;
    out.push({
      date: d,
      gmv,
      orderCount: hit?.orders ?? 0,
      salesCount: saleMap.get(d) ?? 0,
      deliveryCost,
      refund,
      // 与大盘营收同口径：净额 = 总额 − 退款 − 配送成本
      net: gmv - refund - deliveryCost,
    });
  }
  return out;
}

// 漏斗各级（顺序即转化路径）；stage 必须与 UserEvent.eventType 一致
const FUNNEL_STAGES = [
  { stage: 'app_launch', label: '进入小程序' },
  { stage: 'product_view', label: '浏览商品' },
  { stage: 'add_cart', label: '加入购物车' },
  { stage: 'create_order', label: '提交订单' },
  { stage: 'pay_success', label: '支付成功' },
] as const;

/**
 * 转化漏斗：按会话去重（sessionId 优先，回落 userId）
 * ratio 相对上一级，rate 相对首级
 */
export async function funnel(days = 30) {
  const safeDays = Math.min(Math.max(days, 1), 90);
  const from = new Date(startOfToday().getTime() - (safeDays - 1) * 86400000);

  type Row = { eventType: string; cnt: bigint; uv: bigint };
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT eventType,
           COUNT(*) AS cnt,
           COUNT(DISTINCT IFNULL(sessionId, CAST(userId AS CHAR))) AS uv
    FROM UserEvent
    WHERE createdAt >= ${from} AND eventType IN ('app_launch','product_view','add_cart','create_order','pay_success')
    GROUP BY eventType
  `);

  const map = new Map(rows.map((r) => [r.eventType, { cnt: Number(r.cnt), uv: Number(r.uv) }]));
  // 首级用「启动会话数」作为漏斗入口
  const launch = map.get('app_launch')?.uv ?? 0;
  let prev = 0;

  const list = FUNNEL_STAGES.map((s, idx) => {
    const hit = map.get(s.stage);
    const value = idx === 0 ? launch || hit?.uv || 0 : hit?.uv ?? 0;
    const ratio = idx === 0 ? (value > 0 ? 100 : 0) : prev > 0 ? Number(((value / prev) * 100).toFixed(1)) : 0;
    const rate = launch > 0 ? Number(((value / launch) * 100).toFixed(1)) : 0;
    prev = value || prev;
    return { ...s, value, count: hit?.cnt ?? 0, ratio, rate };
  });

  // 找出流失最严重的一跳，作为优化建议
  let worst: { from: string; to: string; dropRate: number } | null = null;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1].value;
    const b = list[i].value;
    if (a > 0 && b / a < 1) {
      const drop = (1 - b / a) * 100;
      if (!worst || drop > worst.dropRate) {
        worst = { from: list[i - 1].label, to: list[i].label, dropRate: Number(drop.toFixed(1)) };
      }
    }
  }

  return { stages: list, worst };
}

export type Advice = { level: 'info' | 'warn' | 'danger'; title: string; detail: string };

/**
 * 经营建议：从现有数据 + 埋点派生规则，不做主观臆测
 * 覆盖：支付转化、加购转化、GMV 环比、库存健康、滞销、动销、销售集中度
 */
export async function advice(days = 30): Promise<Advice[]> {
  const safeDays = Math.min(Math.max(days, 1), 90);
  const out: Advice[] = [];
  const today = startOfToday();
  const yesterday = new Date(today.getTime() - 86400000);
  const from30 = new Date(today.getTime() - 29 * 86400000);
  const from90 = new Date(today.getTime() - 89 * 86400000);

  const [f, todayGmv, yestGmv, lowSku, allOn, soldIn30, soldIn90, topItems] = await Promise.all([
    funnel(safeDays),
    prisma.order.aggregate({ where: { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: today } }, _sum: { totalAmount: true } }),
    prisma.order.aggregate({ where: { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: yesterday, lt: today } }, _sum: { totalAmount: true } }),
    prisma.sku.count({ where: { stock: { lte: 10 } } }),
    prisma.product.count({ where: { status: 'ON' } }),
    prisma.orderItem.groupBy({ by: ['productId'], where: { order: { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: from30 } } } }),
    prisma.orderItem.groupBy({ by: ['productId'], where: { order: { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: from90 } } } }),
    prisma.orderItem.findMany({
      where: { order: { status: { in: PAID_STATUSES as never[] }, paidAt: { gte: from30 } } },
      select: { productId: true, price: true, quantity: true },
    }),
  ]);

  // 1) 支付转化率：提交订单 → 支付成功
  const orderStage = f.stages.find((s) => s.stage === 'create_order');
  const payStage = f.stages.find((s) => s.stage === 'pay_success');
  if (orderStage && orderStage.value > 0 && payStage) {
    const rate = (payStage.value / orderStage.value) * 100;
    out.push(
      rate >= 80
        ? { level: 'info', title: '支付转化健康', detail: `近 ${safeDays} 天支付转化率 ${rate.toFixed(1)}%，链路通畅。` }
        : {
            level: rate >= 50 ? 'warn' : 'danger',
            title: '支付转化偏低',
            detail: `近 ${safeDays} 天有 ${orderStage.value} 次提交订单，仅 ${payStage.value} 次支付成功（${rate.toFixed(1)}%）。建议排查支付流程是否顺畅、价格是否过高，可考虑缩短下单到支付的路径或加强下单提醒。`,
          }
    );
  }

  // 2) 加购 → 下单转化
  const cartStage = f.stages.find((s) => s.stage === 'add_cart');
  if (cartStage && cartStage.value > 0 && orderStage) {
    const rate = (orderStage.value / cartStage.value) * 100;
    if (rate < 30) {
      out.push({
        level: 'warn',
        title: '购物车转化弱',
        detail: `加购后仅 ${rate.toFixed(1)}% 提交了订单。若加购量不小但转化低，常见原因是运费门槛、凑单不足或价格犹豫，可考虑满减提示。`,
      });
    }
  }

  // 3) 今日 GMV 环比昨日
  const t = todayGmv._sum.totalAmount ?? 0;
  const y = yestGmv._sum.totalAmount ?? 0;
  if (y > 0) {
    const delta = ((t - y) / y) * 100;
    out.push(
      t === 0
        ? { level: 'warn', title: '今日暂无成交', detail: `昨日 GMV ${(y / 100).toFixed(2)} 元，今日为 0。建议检查商品是否仍在架、库存是否充足。` }
        : {
            level: delta >= 0 ? 'info' : 'warn',
            title: delta >= 0 ? '今日 GMV 环比上升' : '今日 GMV 环比下降',
            detail: `今日 ${(t / 100).toFixed(2)} 元，昨日 ${(y / 100).toFixed(2)} 元，环比 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%。`,
          }
    );
  }

  // 4) 库存健康
  if (lowSku > 0) {
    out.push({
      level: lowSku >= 5 ? 'danger' : 'warn',
      title: `${lowSku} 个 SKU 库存偏低`,
      detail: `库存 ≤ 10 的 SKU 共 ${lowSku} 个，建议尽快补货；断货会直接损失 GMV。`,
    });
  }

  // 5) 滞销：90 天零销量且仍在售
  const sold90Ids = new Set(soldIn90.map((g) => g.productId));
  const onProducts = await prisma.product.findMany({ where: { status: 'ON' }, select: { id: true, name: true } });
  const stale = onProducts.filter((p) => !sold90Ids.has(p.id));
  if (allOn > 0 && stale.length > 0) {
    const rate = (stale.length / allOn) * 100;
    out.push({
      level: rate >= 50 ? 'danger' : 'info',
      title: `${stale.length} 个在售商品 90 天零销量`,
      detail: `滞销占比 ${rate.toFixed(0)}%${stale.length <= 3 ? `：${stale.map((p) => p.name).join('、')}` : ''}。建议优化主图/标题、调整定价，或考虑下架腾出仓位。`,
    });
  }

  // 6) 动销率
  if (allOn > 0 && soldIn30.length > 0) {
    const rate = (soldIn30.length / allOn) * 100;
    out.push({
      level: rate >= 50 ? 'info' : 'warn',
      title: `近 30 天动销率 ${rate.toFixed(0)}%`,
      detail: `${soldIn30.length}/${allOn} 个在售商品有成交，动销偏低时优先把资源投给已验证的爆款。`,
    });
  }

  // 7) 销售集中度：过度依赖单一商品的风险提示
  const totalGmv = topItems.reduce((s, i) => s + i.price * i.quantity, 0);
  if (totalGmv > 0) {
    const byProduct = new Map<number, number>();
    for (const i of topItems) byProduct.set(i.productId, (byProduct.get(i.productId) ?? 0) + i.price * i.quantity);
    const sorted = [...byProduct.values()].sort((a, b) => b - a);
    const top1 = (sorted[0] / totalGmv) * 100;
    if (top1 >= 60) {
      out.push({
        level: 'warn',
        title: '销售过度集中于单一商品',
        detail: `TOP1 商品贡献了 ${top1.toFixed(0)}% 的 GMV，单品断货或竞品降价会直接冲击营收，建议扩充腰部商品。`,
      });
    }
  }

  return out;
}
