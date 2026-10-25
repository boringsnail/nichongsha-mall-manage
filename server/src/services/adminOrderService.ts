import { prisma } from '../db.js';
import { notFound, orderIllegal } from '../utils/HttpError.js';
import { syncFulfillmentQuietly } from './orderService.js';

export async function listAdminOrders(query: { status?: string; page?: number; size?: number }) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 10));
  const where = { ...(query.status ? { status: query.status as never } : {}) };
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      include: { user: true, items: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
    }),
  ]);
  return {
    list: rows.map((o) => ({
      orderNo: o.orderNo,
      user: { openid: o.user.openid, nickname: o.user.nickname },
      totalAmount: o.totalAmount,
      freight: o.freight,
      status: o.status,
      remark: o.remark,
      createdAt: o.createdAt,
      itemCount: o.items.length,
    })),
    total,
    page,
    size,
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
    status: order.status,
    remark: order.remark,
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    createdAt: order.createdAt,
    logisticsCompany: order.logisticsCompany,
    trackingNo: order.trackingNo,
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
export async function shipOrder(orderNo: string, data: { logisticsCompany: string; trackingNo: string }) {
  const order = await prisma.order.findUnique({ where: { orderNo } });
  if (!order) throw notFound('订单不存在');

  // 发货前先对账一次：若商家已经在微信后台录过发货，本地状态会变成已发货，
  // 下面就会拦住重复发货（否则同一单会向微信上报两个不同单号，用户侧物流对不上）。
  if (order.status === 'PAID') await syncFulfillmentQuietly(orderNo);
  const current = await prisma.order.findUniqueOrThrow({ where: { orderNo } });
  if (current.status === 'SHIPPED' || current.status === 'COMPLETED') {
    throw orderIllegal('该订单已发货（可能已在微信「订单发货管理」中录入），请勿重复发货');
  }
  if (current.status !== 'PAID') throw orderIllegal('仅已支付订单可发货');

  const updated = await prisma.order.updateMany({
    where: { orderNo, status: 'PAID' },
    data: { status: 'SHIPPED', shippedAt: new Date(), logisticsCompany: data.logisticsCompany, trackingNo: data.trackingNo },
  });
  if (updated.count !== 1) throw orderIllegal('订单状态已变化');
  // 实物交易合规：发货后必须把物流信息上报微信「订单发货管理」。
  // 上报失败不影响发货结果（订单已置为已发货），但把原因回给管控台便于处理。
  const { uploadShippingInfo } = await import('./shippingService.js');
  const wechatShipping = await uploadShippingInfo(orderNo);
  const shipped = await prisma.order.findUniqueOrThrow({ where: { orderNo } });
  return { ...shipped, wechatShipping };
}
