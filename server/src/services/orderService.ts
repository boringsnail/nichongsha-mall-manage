import { prisma } from '../db.js';
import { badRequest, notFound, orderIllegal, stockNotEnough } from '../utils/HttpError.js';
import { isWechatPayEnabled, payProvider, simulatePay, createPrepay, markPaidFromNotify } from './payService.js';
import { getWechatOrderState, WX_ORDER_STATE } from './shippingService.js';
import type { Prisma } from '@prisma/client';
import { secureRandomFour } from '../auth/jwt.js';

export interface OrderLineInput {
  skuId: number;
  quantity: number;
}

interface ResolvedLine {
  skuId: number;
  productId: number;
  productName: string;
  specName: string;
  coverImage: string;
  price: number;
  quantity: number;
  subtotal: number;
}

function checkQty(q: number) {
  if (!Number.isInteger(q) || q < 1 || q > 999) throw badRequest('PARAM_ERROR', '数量须为 1~999 的整数');
}

// 订单号：NPA + yyMMddHHmmss + 4 位加密安全随机
function genOrderNo() {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ymdhms = `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const rand = secureRandomFour();
  return `NPA${ymdhms}${rand}`;
}

// ---------- 两个超时口径（前端倒计时与服务端动作必须同源，否则倒计时就是假的） ----------

/** 未支付订单超时时长（分钟），默认 30。环境变量 ORDER_EXPIRE_MINUTES */
export function orderExpireMinutes(): number {
  const n = Number(process.env.ORDER_EXPIRE_MINUTES ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** 发货后自动确认收货天数，默认 10（与微信「发货后 T+10 自动确认收货」对齐）。环境变量 AUTO_CONFIRM_DAYS */
export function autoConfirmDays(): number {
  const n = Number(process.env.AUTO_CONFIRM_DAYS ?? 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** 支付截止时刻 = 下单时间 + 超时时长（与超时取消用的是同一个值） */
export function payExpireAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + orderExpireMinutes() * 60 * 1000);
}

/** 自动确认收货时刻 = 发货时间 + 自动确认天数 */
export function autoConfirmAt(shippedAt: Date): Date {
  return new Date(shippedAt.getTime() + autoConfirmDays() * 24 * 60 * 60 * 1000);
}

/**
 * 微信侧支付截止时间（RFC3339），与本地超时取消时间**完全一致**。
 *
 * 早期版本这里会兜底成「至少留 5 分钟」，结果出现「倒计时已归零、订单已取消，
 * 但微信侧预支付单还能再付 5 分钟」——钱收了、订单是关闭的，只能人工退款。
 * 现在不再兜底：过期就不让下单支付，宁可让用户重新下单。
 */
function payDeadline(createdAt: Date): string {
  const at = payExpireAt(createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// 解析行：校验数量/存在性/上架状态/库存，价格取 SKU 现价
//
// 库存必须在「预览」阶段就拦：否则缺货商品能一路走到确认订单页，用户填完地址点提交
// 才收到「库存不足」，体验极差；而且商品详情页/购物车若未拦住，这里是唯一的兜底。
// createOrder 里仍保留条件扣减（stock >= quantity）作为并发超卖的最终防线。
async function resolveLines(items: OrderLineInput[]): Promise<ResolvedLine[]> {
  return Promise.all(items.map(async ({ skuId, quantity }) => {
    checkQty(quantity);
    const sku = await prisma.sku.findUnique({ where: { id: skuId }, include: { product: true } });
    if (!sku || sku.product.status !== 'ON') throw notFound('商品不存在或已下架');
    if (sku.stock < quantity) {
      throw stockNotEnough(
        sku.stock <= 0
          ? `「${sku.product.name} ${sku.specName}」已售罄`
          : `「${sku.product.name} ${sku.specName}」库存仅剩 ${sku.stock} 件`,
      );
    }
    return {
      skuId,
      productId: sku.productId,
      productName: sku.product.name,
      specName: sku.specName,
      coverImage: sku.product.coverImage,
      price: sku.price,
      quantity,
      subtotal: sku.price * quantity,
    };
  }));
}

async function ownedOrder(uid: number, orderNo: string) {
  const order = await prisma.order.findFirst({ where: { orderNo, userId: uid }, include: { items: true } });
  if (!order) throw notFound('订单不存在');
  return order;
}

function toSummary(order: { orderNo: string; totalAmount: number; freight: number; status: string; createdAt: Date; paidAt?: Date | null; shippedAt?: Date | null; completedAt?: Date | null; cancelledAt?: Date | null }) {
  const now = Date.now();
  const payExpire = payExpireAt(order.createdAt);
  const confirmDue = order.shippedAt ? autoConfirmAt(order.shippedAt) : null;
  return {
    orderNo: order.orderNo,
    totalAmount: order.totalAmount,
    freight: order.freight,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    // 倒计时用「剩余毫秒」而不是时间戳：前端拿自己的时钟倒数即可，不受手机时间不准影响
    payExpireAt: payExpire.toISOString(),
    cancelRemainMs: order.status === 'PENDING_PAYMENT' ? Math.max(0, payExpire.getTime() - now) : null,
    autoConfirmAt: confirmDue ? confirmDue.toISOString() : null,
    confirmRemainMs: order.status === 'SHIPPED' && confirmDue ? Math.max(0, confirmDue.getTime() - now) : null,
    serverNow: new Date(now).toISOString(),
  };
}

export async function previewOrder(uid: number, items: OrderLineInput[], addressId: number) {
  if (!items.length) throw badRequest('PARAM_ERROR', '订单项不能为空');
  const address = await prisma.address.findFirst({ where: { id: addressId, userId: uid } });
  if (!address) throw notFound('地址不存在');
  const lines = await resolveLines(items);
  const totalAmount = lines.reduce((s, l) => s + l.subtotal, 0);
  return {
    totalAmount,
    freight: 0,
    address,
    items: lines.map(({ productId, ...rest }) => rest),
  };
}

export async function createOrder(uid: number, items: OrderLineInput[], addressId: number, remark?: string, fromCart = true) {
  if (!items.length) throw badRequest('PARAM_ERROR', '订单项不能为空');
  const address = await prisma.address.findFirst({ where: { id: addressId, userId: uid } });
  if (!address) throw notFound('地址不存在');
  const lines = await resolveLines(items);
  const totalAmount = lines.reduce((s, l) => s + l.subtotal, 0);
  const addressSnapshot = JSON.stringify(address);

  // orderNo 随机碰撞极小，碰撞则整个事务回滚后重试（最多 5 次）
  for (let attempt = 0; attempt < 5; attempt++) {
    const orderNo = genOrderNo();
    try {
      await prisma.$transaction(async (tx) => {
        // 1) 条件化扣库存：stock >= quantity 才扣，防止并发超卖
        for (const line of lines) {
          const updated = await tx.sku.updateMany({
            where: { id: line.skuId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          });
          if (updated.count !== 1) throw stockNotEnough(`「${line.productName}」库存不足`);
        }
        // 2) 建订单（含地址快照）+ 明细快照
        await tx.order.create({
          data: {
            orderNo,
            userId: uid,
            totalAmount,
            freight: 0,
            remark: remark?.trim() || null,
            addressSnapshot,
            items: {
              create: lines.map((l) => ({
                skuId: l.skuId,
                productId: l.productId,
                productName: l.productName,
                specName: l.specName,
                coverImage: l.coverImage,
                price: l.price,
                quantity: l.quantity,
              })),
            },
          },
        });
        // 3) 购物车结算才清已购条目；立即购买不清（用户可能留购物车中的同款）
        if (fromCart) {
          await tx.cart.deleteMany({ where: { userId: uid, skuId: { in: lines.map((l) => l.skuId) } } });
        }
      });
      return { orderNo, totalAmount };
    } catch (e) {
      // 仅 Prisma P2002（唯一约束冲突 = 订单号碰撞）才重试；库存不足等业务错误直接抛出
      const isP2002 = (e as { code?: string })?.code === 'P2002';
      if (!isP2002) throw e;
    }
  }
  throw new Error('unreachable');
}

export async function listOrders(uid: number, query: { status?: string; page?: number; size?: number }) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 10));
  const now = Date.now();
  const where = { userId: uid, ...(query.status ? { status: query.status as never } : {}) };
  const fetchPage = () =>
    prisma.order.findMany({
      where,
      include: { items: { orderBy: { id: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
    });


  const [totalBefore, first] = await Promise.all([prisma.order.count({ where }), fetchPage()]);
  let total = totalBefore;

  // 列表里的「待支付」和「待发货/待收货」订单顺手对账：
  // 用户付完款最常先看「我的订单」，商家在微信后台发货后用户也在这里看，
  // 这两处不同步就是最刺眼的问题。限各 3 笔 + 节流，有变化才重查一次。
  // 并发发起（而不是 for await 串行），避免首屏多等几个 RTT。
  let rows = first;
  const pending = rows.filter((o) => o.status === 'PENDING_PAYMENT').slice(0, 3);
  const active = rows.filter((o) => o.status === 'PAID' || o.status === 'SHIPPED').slice(0, 3);
  const results = await Promise.all([
    ...pending.map((o) => settlePendingQuietly(o)),
    ...active.map((o) => syncFulfillmentQuietly(o.orderNo)),
  ]);
  if (results.some(Boolean)) {
    // 状态变化可能让订单离开当前筛选（如「待发货」tab 里刚发货的订单），total 也要重算
    [total, rows] = await Promise.all([prisma.order.count({ where }), fetchPage()]);
  }

  return {
    list: rows.map((o) => ({
      orderNo: o.orderNo,
      totalAmount: o.totalAmount,
      status: o.status,
      createdAt: o.createdAt,
      remark: o.remark,
      logisticsCompany: o.logisticsCompany,
      trackingNo: o.trackingNo,
      // 售后标记：列表页据此显示「退款中」「已退款」角标
      afterSaleStatus: o.afterSaleStatus,
      hasAfterSale: Boolean(o.afterSaleStatus),
      itemCount: o.items.length,
      // 倒计时（毫秒）：待付款给「还有多久自动取消」，待收货给「还有多久自动确认收货」
      cancelRemainMs:
        o.status === 'PENDING_PAYMENT' ? Math.max(0, payExpireAt(o.createdAt).getTime() - now) : null,
      confirmRemainMs:
        o.status === 'SHIPPED' && o.shippedAt ? Math.max(0, autoConfirmAt(o.shippedAt).getTime() - now) : null,
      items: o.items.map((i) => ({
        productName: i.productName,
        specName: i.specName,
        coverImage: i.coverImage,
        price: i.price,
        quantity: i.quantity,
      })),
    })),
    total,
    page,
    size,
  };
}

/**
 * 订单详情附带的售后摘要。
 * 只取最新一笔，够详情页显示「售后处理中 · 查看」；完整信息由售后详情页单独拉。
 */
async function latestAfterSaleBrief(orderId: number) {
  const row = await prisma.afterSale.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { afterSaleNo: true, type: true, status: true, refundAmount: true, refundedAmount: true },
  });
  return row ?? null;
}

export async function getOrderDetail(uid: number, orderNo: string) {
  let order = await ownedOrder(uid, orderNo);

  // 待付款：到期就当场关单（前端倒计时归零后一定会来读一次），未到期则查单补落已支付
  if (order.status === 'PENDING_PAYMENT') {
    if (await settlePendingQuietly(order)) order = await ownedOrder(uid, orderNo);
  }

  // 已支付 / 已发货的订单同样要对账：商家在微信后台录发货只更新微信侧，
  // 不拉一次就会出现「商家已发货、用户侧还是待发货」。
  if (order.status === 'PAID' || order.status === 'SHIPPED') {
    if (await syncFulfillmentQuietly(orderNo)) order = await ownedOrder(uid, orderNo);
  }

  // 待收货：发货满 N 天自动确认收货（与前端倒计时同一口径）
  if (order.status === 'SHIPPED') {
    if (await autoCompleteIfDue(order)) order = await ownedOrder(uid, orderNo);
  }

  const now = Date.now();
  const payExpire = payExpireAt(order.createdAt);
  const confirmDue = order.shippedAt ? autoConfirmAt(order.shippedAt) : null;

  return {
    orderNo: order.orderNo,
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
    // 倒计时（毫秒）：前端拿自己的时钟倒数即可，不受手机时间不准影响
    payExpireAt: payExpire.toISOString(),
    cancelRemainMs: order.status === 'PENDING_PAYMENT' ? Math.max(0, payExpire.getTime() - now) : null,
    autoConfirmAt: confirmDue ? confirmDue.toISOString() : null,
    confirmRemainMs: order.status === 'SHIPPED' && confirmDue ? Math.max(0, confirmDue.getTime() - now) : null,
    serverNow: new Date(now).toISOString(),
    // 售后：订单维度的最新售后单（小程序据此显示「退款中 / 退款成功 / 申请售后」入口）
    afterSaleStatus: order.afterSaleStatus,
    refundedAmount: order.refundedAmount,
    afterSale: await latestAfterSaleBrief(order.id),
    address: JSON.parse(order.addressSnapshot),
    items: order.items.map((i) => ({
      skuId: i.skuId,
      productName: i.productName,
      specName: i.specName,
      coverImage: i.coverImage,
      price: i.price,
      quantity: i.quantity,
    })),
  };
}

// 状态机统一：条件更新（PENDING_PAYMENT → …），抢不到状态即 409，天然防并发
//
// 支付三条路径：
//   mock             —— 开发期直接置为已支付
//   wechatpay        —— 微信云托管云调用统一下单（实物类小程序会被微信禁用）
//   wechatpay-direct —— 微信支付 APIv3 直连（商户证书签名，推荐）
// 后两者都只返回 wx.requestPayment 参数，订单保持「待付款」，
// 由支付结果回调（验签 + 主动查单核对）置为「已付款」。

/** 已支付及其之后的状态（都表示钱已经收到） */
const PAID_STATUSES = ['PAID', 'SHIPPED', 'COMPLETED'];

/** 微信侧表示「用户已确认收货 / 交易完成」的状态集合（不含退款与关闭） */
const WX_DONE_STATES = [WX_ORDER_STATE.RECEIVED, WX_ORDER_STATE.FINISHED] as const;

export async function payOrder(uid: number, orderNo: string, opts: { clientIp?: string } = {}) {
  const order = await ownedOrder(uid, orderNo);

  if (order.status !== 'PENDING_PAYMENT') {
    // 钱已经收到了（可能回调刚到、也可能是重复点击）：直接把已支付状态回给前端，
    // 不要抛「订单状态不允许支付」——否则用户付了款却看到报错，是最糟的体验。
    if (PAID_STATUSES.includes(order.status)) {
      return { provider: payProvider(), paid: true, order: toSummary(order) };
    }
    throw orderIllegal('订单状态不允许支付');
  }

  // 已过支付截止时间：不能只靠 5 分钟一轮的扫单，用户此刻点支付必须当场判死。
  // 否则会出现「倒计时已归零、订单随后被关闭，但钱已经付出去了」——只能人工退款。
  if (Date.now() >= payExpireAt(order.createdAt).getTime()) {
    const settled = await cancelIfExpired(order);
    if (settled === 'paid') {
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      return { provider: payProvider(), paid: true, order: toSummary(fresh) };
    }
    throw orderIllegal('订单已超过支付时限并关闭，请重新下单');
  }

  if (!isWechatPayEnabled()) {
    const paid = await simulatePay(order.id);
    return { provider: 'mock' as const, paid: true, order: toSummary(paid) };
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: uid }, select: { openid: true } });

  let payment;
  try {
    payment = await createPrepay({
      orderNo: order.orderNo,
      totalFee: order.totalAmount,
      body: `你宠啥订单 ${order.orderNo}`,
      openid: user.openid,
      clientIp: opts.clientIp || '127.0.0.1',
      timeExpire: payDeadline(order.createdAt),
    });
  } catch (error) {
    // 重复下单：微信侧该 out_trade_no 已存在（常见于「上一次支付成功但回调丢失，
    // 用户又点了一次支付」）。这时不能报错，先查单确认——已支付就直接落库并返回成功。
    const probe = await probePay(orderNo);
    if (probe.status === 'paid') {
      try {
        await markPaidFromNotify(orderNo, probe.transactionId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[pay] 重复下单查单落库竞争 ${orderNo}: ${reason}`);
      }
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      return { provider: payProvider(), paid: true, order: toSummary(fresh) };
    }
    throw error;
  }
  return { provider: payProvider(), paid: false, payment };
}

/** 查单结论：paid=已支付 / unpaid=确认未支付 / unknown=查单失败（不可据此取消订单） */
type PayProbe = { status: 'paid' | 'unpaid' | 'unknown'; transactionId?: string };

/**
 * 向微信支付查单。把三种情况严格区分开：
 *   paid    —— 已支付，调用方应落库
 *   unpaid  —— 微信侧确认未支付（含「查无此单」），调用方可以安全取消订单
 *   unknown —— 网络/鉴权/配置异常，**绝不能据此判断未支付**，否则会把已付款订单取消掉
 */
async function probePay(orderNo: string): Promise<PayProbe> {
  if (payProvider() !== 'wechatpay-direct') return { status: 'unpaid' };
  try {
    const { queryOrderByOutTradeNo } = await import('./wechatpayV3Service.js');
    const res = await queryOrderByOutTradeNo(orderNo);
    return { status: res.paid ? 'paid' : 'unpaid', transactionId: res.transactionId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[pay-probe] 查单失败 ${orderNo}: ${reason}`);
    return { status: 'unknown' };
  }
}

// 对账节流：同一订单 30 秒内只查一次单，避免用户反复刷新打爆微信支付接口
const lastSyncAt = new Map<string, number>();

/** 节流对账：确认已支付则落库。返回是否发生了状态变化 */
async function syncQuietly(orderNo: string): Promise<boolean> {
  const last = lastSyncAt.get(orderNo) ?? 0;
  if (Date.now() - last < 30_000) return false;
  if (lastSyncAt.size > 500) lastSyncAt.clear();
  lastSyncAt.set(orderNo, Date.now());

  const probe = await probePay(orderNo);
  if (probe.status !== 'paid') return false;
  try {
    await markPaidFromNotify(orderNo, probe.transactionId);
    console.log(`[pay-sync] 主动查单补落已支付订单 ${orderNo}`);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[pay-sync] 补落失败 ${orderNo}: ${reason}`);
    return false;
  }
}

/**
 * 关单前先在微信侧关闭预支付单。
 *
 * 「订单已取消」如果只是改本地库，微信侧那张预支付单仍然可以付款——用户付了钱，
 * 订单却是关闭的，只能人工退款。关掉之后该单号再也付不进来，「自动取消」才作数。
 * 关单失败不阻断本地取消（本地取消更重要），只留日志。
 */
async function closePrepayQuietly(orderNo: string): Promise<void> {
  if (payProvider() !== 'wechatpay-direct') return;
  try {
    const { closeOrderByOutTradeNo } = await import('./wechatpayV3Service.js');
    const res = await closeOrderByOutTradeNo(orderNo);
    if (!res.ok) console.warn(`[close] 关闭预支付单失败 ${orderNo}: ${res.error ?? ''}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[close] 关闭预支付单异常 ${orderNo}: ${reason}`);
  }
}

/**
 * 超时未支付订单：到点就真的关掉，而不是干等 5 分钟一轮的扫单。
 *
 * 为什么要在读接口里做：前端有倒计时，归零那一刻用户会刷新、会重试支付。
 * 如果这时订单还挂着「待付款」，倒计时就是假承诺；更糟的是用户还能点支付，
 * 微信侧预支付单若仍有效就会收钱，订单却是关闭的（只能人工退款）。
 *
 * 返回：
 *   cancelled —— 已确认未支付并关闭
 *   paid      —— 查单发现其实已支付，已落库（绝不关闭）
 *   noop      —— 未到期 / 查单失败（状态不明时保守不动，交给扫单）
 */
async function cancelIfExpired(order: { id: number; orderNo: string; createdAt: Date }): Promise<'cancelled' | 'paid' | 'noop'> {
  if (Date.now() < payExpireAt(order.createdAt).getTime()) return 'noop';
  const probe = await probePay(order.orderNo);
  if (probe.status === 'paid') {
    try {
      await markPaidFromNotify(order.orderNo, probe.transactionId);
      console.log(`[expire] 超时订单实为已支付，已补落 ${order.orderNo}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[expire] 补落失败 ${order.orderNo}: ${reason}`);
    }
    return 'paid';
  }
  if (probe.status !== 'unpaid') return 'noop';
  await closePrepayQuietly(order.orderNo);
  const ok = await prisma.$transaction((tx) => doCancel(tx, order.id));
  if (ok) console.log(`[expire] 超时未支付，已关闭订单 ${order.orderNo}`);
  return ok ? 'cancelled' : 'noop';
}

/** 待付款订单对账：到期关单，未到期查单补落已支付。返回状态是否发生变化 */
async function settlePendingQuietly(order: { id: number; orderNo: string; createdAt: Date }): Promise<boolean> {
  if (Date.now() >= payExpireAt(order.createdAt).getTime()) {
    return (await cancelIfExpired(order)) !== 'noop';
  }
  return syncQuietly(order.orderNo);
}

/**
 * 自动确认收货（单笔，读接口用）：发货满 N 天后本地置为已完成。
 *
 * 微信侧确实会自动确认收货，但那只更新微信侧、不回写我们；没接入发货管理的订单
 * 在微信侧根本不会自动确认。本地必须自己有一份规则，前端倒计时才不是空话。
 */
async function autoCompleteIfDue(order: { id: number; orderNo: string; status: string; shippedAt: Date | null; createdAt: Date }): Promise<boolean> {
  if (order.status !== 'SHIPPED') return false;
  const base = order.shippedAt ?? order.createdAt;
  if (Date.now() < autoConfirmAt(base).getTime()) return false;
  const upd = await prisma.order.updateMany({
    where: { id: order.id, status: 'SHIPPED' },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  if (upd.count === 1) console.log(`[auto-confirm] 到期自动确认收货 ${order.orderNo}`);
  return upd.count === 1;
}

/**
 * 自动确认收货（批量，定时任务用）：扫发货已满 N 天的订单。
 * 覆盖用户根本不打开小程序的场景——否则订单会永远停在「待收货」。
 */
export async function autoCompleteShippedOrders(limit = 200): Promise<number> {
  const deadline = new Date(Date.now() - autoConfirmDays() * 24 * 60 * 60 * 1000);
  const rows = await prisma.order.findMany({
    where: {
      status: 'SHIPPED',
      // shippedAt 缺失（极少数历史单）时退化为按创建时间判断，避免永远卡在待收货
      OR: [{ shippedAt: { lte: deadline } }, { shippedAt: null, createdAt: { lte: deadline } }],
    },
    select: { id: true, orderNo: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
  let done = 0;
  for (const row of rows) {
    const upd = await prisma.order.updateMany({
      where: { id: row.id, status: 'SHIPPED' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (upd.count) {
      done += 1;
      console.log(`[auto-confirm] 发货已满 ${autoConfirmDays()} 天，自动确认收货 ${row.orderNo}`);
    }
  }
  return done;
}

/**
 * 履约状态对账（节流）：把微信侧的「已发货 / 已收货 / 交易完成」拉回本地。
 *
 * 为什么必须有：商家最常用的操作路径是微信后台「订单发货管理 → 发货信息录入」，
 * 那里录发货**只更新微信侧**，不会调用我们的接口，也不会回调我们。
 * 如果本地只认自己的状态机，就会出现「商家明明发货了，用户侧一直显示待发货」——
 * 用户以为没发货来投诉，商家以为系统坏了。
 *
 * 同理，微信侧 T+10 天自动确认收货、交易完成，也不会回写本地。
 * 所以每次打开订单详情 / 订单列表、以及定时任务，都要主动拉一次。
 *
 * 安全约束：
 *   1. 只前进不后退（PAID → SHIPPED → COMPLETED），条件更新天然防并发；
 *   2. 微信返回「已退款 / 已关闭」不自动改本地状态——退款涉及资金，必须人工核对；
 *   3. 任何异常都静默返回 false，绝不因为对账失败影响正常读接口。
 */
export async function syncFulfillmentQuietly(
  orderNo: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const key = `f:${orderNo}`;
  const last = lastSyncAt.get(key) ?? 0;
  // 手动「立即同步」需要绕过 30 秒节流，否则用户点了没反应会以为功能坏了
  if (!options.force && Date.now() - last < 30_000) return false;
  if (lastSyncAt.size > 500) lastSyncAt.clear();
  lastSyncAt.set(key, Date.now());

  const info = await getWechatOrderState(orderNo);
  if (!info.ok || typeof info.orderState !== 'number') {
    // 以前这里完全静默，线上出现「微信已发货、本地一直是已支付」时无从下手；
    // 留一条 warn 便于在容器日志里定位（token 失效 / 商户号未配 / 网络不通）。
    console.warn(`[fulfill-sync] 拉取微信订单状态失败 ${orderNo}：${info.error ?? '响应缺少 order_state'}`);
    return false;
  }

  const order = await prisma.order.findUnique({ where: { orderNo } });
  if (!order) return false;

  let changed = false;

  // 1) 物流单号回填：商家在微信后台录了单号、本地还是空 → 直接同步过来，详情页立刻能看物流
  if (info.trackingNo && !order.trackingNo) {
    const data: Prisma.OrderUpdateManyMutationInput = { trackingNo: info.trackingNo };
    if (info.expressCompany && !order.logisticsCompany) data.logisticsCompany = info.expressCompany;
    const upd = await prisma.order.updateMany({ where: { orderNo, trackingNo: null }, data });
    if (upd.count) {
      changed = true;
      console.log(`[fulfill-sync] 回填物流单号 ${orderNo} ${info.expressCompany ?? ''}/${info.trackingNo}`);
    }
  }

  // 2) 状态推进
  if ((WX_DONE_STATES as readonly number[]).includes(info.orderState)) {
    const upd = await prisma.order.updateMany({
      where: { orderNo, status: { in: ['PAID', 'SHIPPED'] } },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        // 微信侧可能一步到「交易完成」（T+10 自动确认收货），本地缺发货时间时补一个，
        // 否则详情页时间轴会出现「完成时间早于发货时间」甚至没有发货时间
        ...(order.shippedAt ? {} : { shippedAt: new Date() }),
      },
    });
    if (upd.count) {
      changed = true;
      console.log(`[fulfill-sync] 微信侧已确认收货/交易完成，本地置为已完成 ${orderNo}`);
    }
  } else if (info.orderState === WX_ORDER_STATE.SHIPPED) {
    const upd = await prisma.order.updateMany({
      where: { orderNo, status: 'PAID' },
      data: { status: 'SHIPPED', shippedAt: order.shippedAt ?? new Date() },
    });
    if (upd.count) {
      changed = true;
      console.log(`[fulfill-sync] 微信侧已发货，本地置为已发货 ${orderNo}`);
    }
  } else if (info.orderState === WX_ORDER_STATE.REFUNDED || info.orderState === WX_ORDER_STATE.CLOSED) {
    // 退款/关闭涉及资金，本地状态机不自动跟随，留痕等人工核对
    console.warn(`[fulfill-sync] 微信侧订单 ${orderNo} 状态为 ${info.orderState}（已退款/已关闭），本地状态 ${order.status} 未自动变更`);
  }

  return changed;
}

/**
 * 定时履约对账：扫描近 60 天内仍处于「待发货 / 已发货」的订单，主动拉微信侧状态。
 * 覆盖用户不打开小程序的场景（商家发货后用户根本没进来看，本地永远是待发货）。
 */
export async function reconcileFulfillment(limit = 50): Promise<number> {
  if (!isWechatPayEnabled()) return 0;
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const rows = await prisma.order.findMany({
    where: { status: { in: ['PAID', 'SHIPPED'] }, createdAt: { gte: since } },
    select: { orderNo: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  let fixed = 0;
  for (const row of rows) {
    if (await syncFulfillmentQuietly(row.orderNo)) fixed += 1;
  }
  return fixed;
}

/**
 * 支付状态对账（主动查单），供前端支付成功后调用。
 *
 * 为什么必须有：支付结果回调可能延迟、被重试、甚至彻底丢失（网络抖动、验签配置
 * 变更、云托管灰度期旧实例没带新配置等）。只依赖回调会出现「用户已付款、订单仍是
 * 待支付」——最严重的资损/客诉场景。这里主动向微信支付查单，已支付则幂等落库。
 */
export async function syncPayStatus(uid: number, orderNo: string) {
  const order = await ownedOrder(uid, orderNo);
  if (order.status !== 'PENDING_PAYMENT') return toSummary(order);

  const probe = await probePay(orderNo);
  if (probe.status !== 'paid') return toSummary(order);

  try {
    await markPaidFromNotify(orderNo, probe.transactionId);
  } catch (error) {
    // 并发场景（回调与查单同时到达）下另一个路径已落库，这里抢输属正常，重读即可
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[pay-sync] 落库竞争 ${orderNo}: ${reason}`);
  }
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  return toSummary(fresh);
}

/**
 * 定时对账：扫描最近 2 小时内仍为「待支付」的订单，主动查单补落。
 * 覆盖前端没机会触发 pay-sync 的场景（用户付完直接退出小程序）。
 */
export async function reconcilePendingPayments(limit = 30): Promise<number> {
  if (payProvider() !== 'wechatpay-direct') return 0;
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const rows = await prisma.order.findMany({
    where: { status: 'PENDING_PAYMENT', createdAt: { gte: since } },
    select: { orderNo: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  let fixed = 0;
  for (const row of rows) {
    const probe = await probePay(row.orderNo);
    if (probe.status !== 'paid') continue;
    try {
      await markPaidFromNotify(row.orderNo, probe.transactionId);
      fixed += 1;
      console.log(`[reconcile] 主动查单补落已支付订单 ${row.orderNo}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[reconcile] 补落失败 ${row.orderNo}: ${reason}`);
    }
  }
  return fixed;
}

export async function cancelOrder(uid: number, orderNo: string) {
  const order = await ownedOrder(uid, orderNo);
  if (order.status !== 'PENDING_PAYMENT') throw orderIllegal('订单状态不允许取消');

  // 取消前必须向微信支付确认：用户可能已经付过款，只是回调还没到。
  // 若已支付 → 先落库为已支付，再拒绝取消，绝不能把已付款订单取消掉。
  const probe = await probePay(orderNo);
  if (probe.status === 'paid') {
    await markPaidFromNotify(orderNo, probe.transactionId);
    throw orderIllegal('该订单已支付成功，无法取消');
  }
  // 查单失败时保守处理：宁可让用户稍后重试，也不能错取消一笔可能已付款的订单
  if (probe.status === 'unknown') {
    throw orderIllegal('暂时无法确认支付状态，请稍后重试取消');
  }

  // 先关微信侧预支付单，再关本地订单：顺序反了就会出现「已取消但还能付」的窗口
  await closePrepayQuietly(orderNo);
  const done = await prisma.$transaction((tx) => doCancel(tx, order.id));
  if (!done) throw orderIllegal('订单状态已变化');
  return toSummary(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }));
}

// 取消核心（供用户取消与系统扫单共用）：条件更新防并发 + 回滚库存；返回是否取消成功
async function doCancel(tx: Prisma.TransactionClient, orderId: number): Promise<boolean> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  const updated = await tx.order.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT' },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  if (updated.count !== 1) return false;
  for (const item of o.items) {
    await tx.sku.update({ where: { id: item.skuId }, data: { stock: { increment: item.quantity } } });
  }
  return true;
}

// 系统扫单：取消超过 N 分钟未支付的订单并回滚库存（index.ts 定时调用）
//
// 关键：取消前必须逐单向微信支付查单。只按「超时未回调」就取消，
// 会把「用户已付款但回调丢失」的订单取消掉并回滚库存——钱收了、货没发、库存还回来了，
// 是最严重的资损场景。查单失败（unknown）时跳过，留到下一轮再判。
export async function cancelExpiredOrders(maxMinutes = orderExpireMinutes()) {
  const deadline = new Date(Date.now() - maxMinutes * 60000);
  const expired = await prisma.order.findMany({
    where: { status: 'PENDING_PAYMENT', createdAt: { lte: deadline } },
    select: { id: true, orderNo: true, createdAt: true },
    orderBy: { id: 'asc' },
    take: 200, // 单轮上限，防止积压过多一次处理太久
  });
  // 预支付单最长有效期 2 小时（未设 time_expire 时的微信默认值）。
  // 超过 2 小时的待支付订单不可能再付款成功，无需查单，直接取消。
  const probeWindowStart = Date.now() - 2 * 60 * 60 * 1000;
  let cancelled = 0;
  for (const { id, orderNo, createdAt } of expired) {
    if (createdAt.getTime() >= probeWindowStart) {
      const probe = await probePay(orderNo);
      if (probe.status === 'paid') {
        // 已付款但回调没到：转为已支付，绝不取消
        try {
          await markPaidFromNotify(orderNo, probe.transactionId);
          console.log(`[sweep] 超时订单实为已支付，已补落 ${orderNo}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[sweep] 超时订单补落失败 ${orderNo}: ${reason}`);
        }
        continue;
      }
      if (probe.status === 'unknown') continue; // 状态不明，本轮不取消
    }

    // 先关微信侧预支付单再关本地：顺序反了会留出「订单已取消但仍可付款」的窗口
    await closePrepayQuietly(orderNo);
    const ok = await prisma.$transaction((tx) => doCancel(tx, id));
    if (ok) cancelled += 1;
  }
  return cancelled;
}

export async function confirmOrder(uid: number, orderNo: string) {
  const order = await ownedOrder(uid, orderNo);
  if (order.status !== 'SHIPPED') throw orderIllegal('订单状态不允许确认收货');

  // 有在途售后时不允许确认收货：退货途中的单被「确认收货」会把订单锁成已完成，
  // 售后金额与状态的校验会变得非常绕（已完成订单还能退款吗？），直接拦住更安全。
  const { hasActiveAfterSale } = await import('./afterSaleService.js');
  if (await hasActiveAfterSale(order.id)) {
    throw orderIllegal('该订单有进行中的售后，请等待售后处理完成');
  }

  const updated = await prisma.order.updateMany({
    where: { id: order.id, status: 'SHIPPED' },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  if (updated.count !== 1) throw orderIllegal('订单状态已变化');
  return toSummary(await prisma.order.findUniqueOrThrow({ where: { id: order.id } }));
}