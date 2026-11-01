import { prisma } from '../db.js';
import { notFound, orderIllegal, badRequest } from '../utils/HttpError.js';
import { syncFulfillmentQuietly } from './orderService.js';
import { getWechatOrderState, LOGISTICS_TYPE, LOGISTICS_TYPE_LABEL } from './shippingService.js';

/** 一张单最多几张配送照片：够证明「放门口了」，又不会把订单详情撑成相册 */
export const MAX_DELIVERY_PHOTOS = 3;

/** 只收自家图床的绝对地址或 /api/media/:id，别让订单表变成任意 URL 的容器 */
const PHOTO_URL_RE = /^(https?:\/\/\S+|\/api\/media\/\d+)$/;

/**
 * deliveryPhotos 存的是 JSON 数组字符串。
 * 历史数据、手改库、旧版本都可能塞进非法值，所以读取一律走这里兜底成 []，
 * 绝不让一个坏字符把整个订单详情打成 500。
 */
export function parseDeliveryPhotos(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function assertDeliveryPhotos(photos: string[]) {
  if (photos.length > MAX_DELIVERY_PHOTOS) {
    throw badRequest('DELIVERY_PHOTO_INVALID', `配送照片最多 ${MAX_DELIVERY_PHOTOS} 张`);
  }
  for (const photo of photos) {
    if (!PHOTO_URL_RE.test(photo)) {
      throw badRequest('DELIVERY_PHOTO_INVALID', '配送照片地址不合法，请重新上传');
    }
  }
}

export async function listAdminOrders(query: {
  status?: string;
  page?: number;
  size?: number;
  /** 列表页 5 秒轮询时带上：顺手把还能变化的订单和微信对一次账 */
  autoSync?: boolean;
}) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 10));
  const where = { ...(query.status ? { status: query.status as never } : {}) };
  const fetchPage = () =>
    prisma.order.findMany({
      where,
      include: { user: true, items: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
    });

  let [total, rows] = await Promise.all([prisma.order.count({ where }), fetchPage()]);

  // 自动同步：只碰当前页里「还能变」的单（待发货 / 已发货）。
  // 单笔 30 秒节流由 syncFulfillmentQuietly 内部兜住，所以前端 5 秒一刷也不会把微信接口打爆：
  // 10 笔订单最坏情况是每 30 秒 10 次 get_order，约 0.33 QPS。
  let synced = 0;
  if (query.autoSync) {
    const active = rows.filter((o) => o.status === 'PAID' || o.status === 'SHIPPED').map((o) => o.orderNo);
    if (active.length) {
      const results = await Promise.all(active.map((orderNo) => syncFulfillmentQuietly(orderNo).catch(() => false)));
      synced = results.filter(Boolean).length;
      if (synced > 0) {
        // 状态变化可能让订单离开当前筛选（例如「待发货」里刚发货的），total 也要重算
        [total, rows] = await Promise.all([prisma.order.count({ where }), fetchPage()]);
      }
    }
  }

  return {
    list: rows.map((o) => ({
      orderNo: o.orderNo,
      user: { openid: o.user.openid, nickname: o.user.nickname },
      totalAmount: o.totalAmount,
      freight: o.freight,
      // 我们付的配送成本（分）：商家在列表里直接录，用于算净营业额
      deliveryCost: o.deliveryCost,
      refundedAmount: o.refundedAmount,
      status: o.status,
      remark: o.remark,
      createdAt: o.createdAt,
      itemCount: o.items.length,
      // 售后角标：列表页据此显示「售后中 / 已退款」，不用再点进详情
      afterSaleStatus: o.afterSaleStatus,
      hasAfterSale: Boolean(o.afterSaleStatus),
      // 列表只要一个「有没有传照片」的标记，卡片上给个小相机图标
      hasDeliveryPhoto: Boolean(o.deliveryPhotos),
    })),
    total,
    page,
    size,
    synced,
    serverTime: new Date().toISOString(),
  };
}

/**
 * 录入配送成本（我们付给骑手/快递的钱，单位分）。
 *
 * 只改 deliveryCost 一列：
 *   - 不动 totalAmount / freight —— 顾客实付的钱是既成事实，商家改成本不该改账单
 *   - 已取消的订单没有履约成本，直接拒掉，避免脏数据进净额口径
 */
export async function setDeliveryCost(orderNo: string, deliveryCost: number) {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: { orderNo: true, status: true, deliveryCost: true },
  });
  if (!order) throw notFound('订单不存在');
  if (order.status === 'CANCELLED') throw orderIllegal('已取消的订单不需要录入配送成本');

  const updated = await prisma.order.update({
    where: { orderNo },
    data: { deliveryCost },
    select: { orderNo: true, deliveryCost: true },
  });

  return { ...updated, previous: order.deliveryCost };
}

/**
 * 录入 / 覆盖配送照片（整组替换，传空数组就是清空）。
 *
 * 做成整组替换而不是增删单张：前端就是「最多 3 张缩略图 + 删除 + 新增」，
 * 整组提交省掉一套「删第几张」的接口和并发问题。
 */
export async function setDeliveryPhotos(orderNo: string, photos: string[]) {
  const order = await prisma.order.findUnique({
    where: { orderNo },
    select: { orderNo: true, status: true, deliveryPhotos: true },
  });
  if (!order) throw notFound('订单不存在');
  if (order.status === 'CANCELLED') throw orderIllegal('已取消的订单不需要上传配送照片');

  assertDeliveryPhotos(photos);

  const updated = await prisma.order.update({
    where: { orderNo },
    // 空数组存 NULL 而不是 "[]"：列表页用 Boolean(deliveryPhotos) 判有没有图，
    // 存 "[]" 会被当成「有照片」，卡片上就多出一个空相机图标
    data: { deliveryPhotos: photos.length ? JSON.stringify(photos) : null },
    select: { orderNo: true, deliveryPhotos: true },
  });

  return {
    orderNo: updated.orderNo,
    deliveryPhotos: parseDeliveryPhotos(updated.deliveryPhotos),
    previous: parseDeliveryPhotos(order.deliveryPhotos),
  };
}

export async function getAdminOrderDetail(orderNo: string) {
  let order = await prisma.order.findUnique({
    where: { orderNo },
    include: { user: true, items: true },
  });
  if (!order) throw notFound('订单不存在');

  // 管控台也要对账：商家可能在微信后台「订单发货管理」里已经录过发货，
  // 本地若还显示「待发货」，商家很可能再发一次、上报第二个单号。
  if (order.status === 'PAID' || order.status === 'SHIPPED') {
    if (await syncFulfillmentQuietly(orderNo)) {
      order = await prisma.order.findUniqueOrThrow({ where: { orderNo }, include: { user: true, items: true } });
    }
  }

  return {
    orderNo: order.orderNo,
    user: { openid: order.user.openid, nickname: order.user.nickname },
    totalAmount: order.totalAmount,
    freight: order.freight,
    deliveryCost: order.deliveryCost,
    refundedAmount: order.refundedAmount,
    status: order.status,
    remark: order.remark,
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    createdAt: order.createdAt,
    logisticsCompany: order.logisticsCompany,
    trackingNo: order.trackingNo,
    logisticsType: order.logisticsType,
    afterSaleStatus: order.afterSaleStatus,
    deliveryPhotos: parseDeliveryPhotos(order.deliveryPhotos),
    address: JSON.parse(order.addressSnapshot),
    items: order.items.map((i) => ({
      productName: i.productName,
      specName: i.specName,
      coverImage: i.coverImage,
      price: i.price,
      quantity: i.quantity,
    })),
  };
}

// 发货：仅 PAID → SHIPPED；条件更新防并发
export interface ShipInput {
  /** 1 快递 / 2 同城配送 / 4 用户自提 */
  logisticsType: number;
  logisticsCompany?: string;
  trackingNo?: string;
  /** 发货时顺手拍的配送照片（选填，最多 3 张） */
  photos?: string[];
}

export async function shipOrder(orderNo: string, data: ShipInput) {
  const order = await prisma.order.findUnique({ where: { orderNo } });
  if (!order) throw notFound('订单不存在');

  const logisticsType = data.logisticsType ?? LOGISTICS_TYPE.EXPRESS;
  if (!LOGISTICS_TYPE_LABEL[logisticsType]) throw orderIllegal('不支持的物流模式');
  if (logisticsType === LOGISTICS_TYPE.VIRTUAL) {
    throw orderIllegal('虚拟商品发货请走专门流程，实体商品请选择快递/同城配送/用户自提');
  }

  // 快递才需要公司与单号；同城配送、用户自提没有快递单号，
  // 物流公司字段直接写配送方式文案，小程序端展示才不会空着。
  const trackingNo = data.trackingNo?.trim() || null;
  const logisticsCompany =
    logisticsType === LOGISTICS_TYPE.EXPRESS
      ? (data.logisticsCompany ?? '').trim()
      : LOGISTICS_TYPE_LABEL[logisticsType];
  if (logisticsType === LOGISTICS_TYPE.EXPRESS && (!logisticsCompany || !trackingNo)) {
    throw orderIllegal('快递发货需要填写物流公司和物流单号');
  }

  // 发货前先对账一次：若商家已经在微信后台录过发货，本地状态会变成已发货，
  // 下面就会拦住重复发货（否则同一单会向微信上报两个不同单号，用户侧物流对不上）。
  if (order.status === 'PAID') await syncFulfillmentQuietly(orderNo);
  const current = await prisma.order.findUniqueOrThrow({ where: { orderNo } });
  if (current.status === 'SHIPPED' || current.status === 'COMPLETED') {
    throw orderIllegal('该订单已发货（可能已在微信「订单发货管理」中录入），请勿重复发货');
  }
  if (current.status !== 'PAID') throw orderIllegal('仅已支付订单可发货');

  // 已退款还发货 = 钱退了货也发了，是实打实的亏损单。
  // 微信侧退款不会改本地 status（订单本身仍是已支付），所以必须单独看退款金额。
  const refunded = current.refundedAmount ?? 0;
  const fullyRefunded = refunded > 0 && refunded >= current.totalAmount;
  if (fullyRefunded || current.afterSaleStatus === 'COMPLETED') {
    throw orderIllegal('该订单已退款，不能再发货');
  }

  const photos = data.photos ?? [];
  if (photos.length) assertDeliveryPhotos(photos);

  const updated = await prisma.order.updateMany({
    where: { orderNo, status: 'PAID' },
    data: {
      status: 'SHIPPED',
      shippedAt: new Date(),
      logisticsType,
      logisticsCompany,
      trackingNo,
      // 只在这次真带了照片时才写，避免「不传照片」把之前补传的清空
      ...(photos.length ? { deliveryPhotos: JSON.stringify(photos) } : {}),
    },
  });
  if (updated.count !== 1) throw orderIllegal('订单状态已变化');
  // 实物交易合规：发货后必须把物流信息上报微信「订单发货管理」。
  // 上报失败不影响发货结果（订单已置为已发货），但把原因回给管控台便于处理。
  const { uploadShippingInfo } = await import('./shippingService.js');
  const wechatShipping = await uploadShippingInfo(orderNo);
  const shipped = await prisma.order.findUniqueOrThrow({ where: { orderNo } });
  return { ...shipped, wechatShipping };
}

/**
 * 手动同步单笔订单的微信侧状态（绕过 30 秒节流）。
 *
 * 场景：商家习惯在微信后台「订单发货管理 → 发货信息录入」里录发货，
 * 那里只改微信侧、不回调我们；管控台给一个「立即同步」入口，点一下就能拉回来。
 */
export async function syncAdminOrderFromWechat(orderNo: string) {
  const before = await prisma.order.findUnique({ where: { orderNo } });
  if (!before) throw notFound('订单不存在');

  const changed = await syncFulfillmentQuietly(orderNo, { force: true });
  const latest = await prisma.order.findUniqueOrThrow({ where: { orderNo } });

  // 没变化时把微信侧的原始状态带回去：否则用户点完按钮只看到「还是待发货」，
  // 分不清是「微信那边也还没发货」还是「我们这边拉取失败了」
  const wx = changed ? null : await getWechatOrderState(orderNo);

  return {
    orderNo,
    changed,
    before: before.status,
    status: latest.status,
    shippedAt: latest.shippedAt,
    logisticsCompany: latest.logisticsCompany,
    trackingNo: latest.trackingNo,
    wxState: wx
      ? { ok: wx.ok, orderState: wx.orderState ?? null, trackingNo: wx.trackingNo ?? null, error: wx.error ?? null }
      : null,
  };
}

/**
 * 批量对账：把近 60 天内「已支付 / 已发货」的订单逐笔与微信侧核对。
 * 供管控台「同步微信状态」按钮使用；单笔失败不影响其余订单。
 */
export async function syncAdminOrdersFromWechat(limit = 30) {
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const rows = await prisma.order.findMany({
    where: { status: { in: ['PAID', 'SHIPPED'] }, createdAt: { gte: since } },
    select: { orderNo: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (await syncFulfillmentQuietly(row.orderNo, { force: true })) updated += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[fulfill-sync] 批量对账失败 ${row.orderNo}:`, error instanceof Error ? error.message : error);
    }
  }
  return { checked: rows.length, updated, failed };
}
