import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError, orderIllegal } from '../utils/HttpError.js';

// 微信支付：两种实现
//   wechatpay —— 微信云托管「云调用」支付（推荐）：免证书、免签名，平台代转发微信支付
//   mock      —— 开发期模拟支付（仅 devMode 使用）
// 云调用文档：微信云托管 → 操作指南 → 微信开放能力 → 微信支付
//   统一下单 POST http://api.weixin.qq.com/_/pay/unifiedOrder

const CLOUD_PAY_BASE = 'http://api.weixin.qq.com/_/pay';

/** 小程序 wx.requestPayment 所需参数（由统一下单原样返回） */
export interface PaymentParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: string;
  paySign: string;
}

interface CloudCallResponse<T> {
  errcode?: number;
  errmsg?: string;
  respdata?: T;
}

/** 云调用统一入口：网络层异常与非 0 errcode 都转成可诊断的 502 */
async function cloudPayCall<T>(api: string, payload: Record<string, unknown>): Promise<T> {
  const url = `${CLOUD_PAY_BASE}/${api}`;
  let data: CloudCallResponse<T>;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = (await res.json()) as CloudCallResponse<T>;
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[wxpay] 云调用 ${api} 网络层失败（容器需可访问 api.weixin.qq.com，或开启「开放接口服务」云调用）:`, reason);
    throw new HttpError(502, 'PAY_UNAVAILABLE', '微信支付服务不可用（详见容器日志 [wxpay]）');
  }
  if (data.errcode !== 0) {
    console.error(`[wxpay] 云调用 ${api} 失败：errcode=${data.errcode} errmsg=${data.errmsg}`);
    throw new HttpError(502, 'PAY_UNAVAILABLE', `微信支付失败：${data.errmsg ?? '未知错误'}（errcode=${data.errcode}）`);
  }
  return (data.respdata ?? {}) as T;
}

export function isWechatPayEnabled(): boolean {
  return env.pay.provider === 'wechatpay' || env.pay.provider === 'wechatpay-direct';
}

/** 当前支付通道：mock（开发）/ wechatpay（云调用）/ wechatpay-direct（APIv3 直连） */
export function payProvider(): 'mock' | 'wechatpay' | 'wechatpay-direct' {
  return env.pay.provider;
}

/**
 * 统一下单入口（按配置选择通道）：
 *   - wechatpay-direct：APIv3 直连（商户证书签名，不受「实物交易禁用云调用」限制）
 *   - wechatpay：微信云托管云调用
 */
export async function createPrepay(input: {
  orderNo: string;
  totalFee: number;
  body: string;
  openid: string;
  clientIp: string;
  timeExpire?: string;
}): Promise<PaymentParams> {
  if (env.pay.provider === 'wechatpay-direct') {
    const { jsapiPrepay } = await import('./wechatpayV3Service.js');
    return jsapiPrepay({
      orderNo: input.orderNo,
      totalFee: input.totalFee,
      body: input.body,
      openid: input.openid,
      timeExpire: input.timeExpire,
    });
  }
  return unifiedOrder(input);
}

/** 从 payment.package 中取出 prepay_id；为空说明微信侧未真正生成预支付单 */
function extractPrepayId(payment?: PaymentParams): string {
  const matched = /prepay_id=([^\s&]+)/.exec(payment?.package ?? '');
  return matched ? matched[1] : '';
}

/**
 * 统一下单：返回小程序端 wx.requestPayment 所需的 payment 参数。
 * 订单在此阶段仍是「待付款」，真正转为「已付款」以支付结果回调/主动查单为准。
 */
export async function unifiedOrder(input: {
  orderNo: string;
  totalFee: number;
  body: string;
  openid: string;
  clientIp: string;
}): Promise<PaymentParams> {
  const respdata = await cloudPayCall<{
    return_code?: string;
    return_msg?: string;
    result_code?: string;
    err_code?: string;
    err_code_des?: string;
    payment?: PaymentParams;
  }>('unifiedOrder', {
    body: input.body.slice(0, 120),
    openid: input.openid,
    out_trade_no: input.orderNo,
    spbill_create_ip: input.clientIp,
    env_id: env.pay.envId,
    sub_mch_id: env.pay.subMchId,
    total_fee: input.totalFee,
    callback_type: 2, // 2 = 支付结果通知到云托管服务
    container: { service: env.pay.notifyService, path: env.pay.notifyPath },
  });

  // 关键：errcode=0 不等于下单成功。商户号未完成「服务商授权」（受理关系不存在）时，
  // 云调用会返回 errcode=0 但 package="prepay_id="（空），若直接透传，前端拿到的参数无法支付且报错难定位。
  if (!respdata.payment || !extractPrepayId(respdata.payment)) {
    const reason =
      respdata.err_code_des ||
      respdata.return_msg ||
      '未返回 prepay_id（常见原因：商户号尚未在云托管完成「服务商授权」，或商户号状态受限）';
    console.error(
      `[wxpay] 统一下单未生成预支付单：return_code=${respdata.return_code ?? '-'} result_code=${respdata.result_code ?? '-'} ` +
        `err_code=${respdata.err_code ?? '-'} err_code_des=${respdata.err_code_des ?? '-'}`,
    );
    throw new HttpError(502, 'PAY_UNAVAILABLE', `统一下单失败：${reason}`);
  }
  return respdata.payment;
}

/**
 * 主动查单。回调可能被伪造（服务若开放公网），因此一律以查单结果为准。
 */
export async function queryOrderPaid(orderNo: string): Promise<{ paid: boolean; transactionId?: string }> {
  const respdata = await cloudPayCall<Record<string, unknown>>('queryorder', {
    out_trade_no: orderNo,
    sub_mch_id: env.pay.subMchId,
    env_id: env.pay.envId,
  });
  const state = String(respdata.trade_state ?? respdata.tradeState ?? '');
  const transactionId = (respdata.transaction_id ?? respdata.transactionId) as string | undefined;
  return { paid: state === 'SUCCESS', transactionId };
}

/** 标记订单已支付：条件更新防并发 + 累加销量（幂等：重复调用不会重复累加） */
export async function markOrderPaid(orderId: number) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDING_PAYMENT' },
      data: { status: 'PAID', paidAt: new Date() },
    });
    if (updated.count !== 1) throw orderIllegal('订单状态已变化');
    for (const item of order.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { salesCount: { increment: item.quantity } },
      });
    }
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  });
}

/** 开发期模拟支付（PAY_PROVIDER=mock） */
export const simulatePay = markOrderPaid;

/**
 * 支付结果落库（幂等）：APIv3 直连通知在验签解密后调用，云调用回调在主动查单确认后调用。
 * 返回 ok=false 时调用方应让平台重试。
 */
export async function markPaidFromNotify(
  outTradeNo: string,
  transactionId?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const order = await prisma.order.findUnique({ where: { orderNo: outTradeNo } });
  if (!order) return { ok: false, reason: '订单不存在' };
  if (order.status === 'PAID' || order.status === 'SHIPPED' || order.status === 'COMPLETED') {
    return { ok: true }; // 幂等
  }
  if (order.status === 'CANCELLED') {
    // 订单已被取消，但微信侧确实收到了钱（典型成因：用户在超时取消的瞬间完成支付）。
    // 这是「钱收了、单没了」的异常单，必须人工退款。
    // 落 paymentNo 留痕 + ERROR 日志，并返回 ok=true 让微信停止重试（否则会持续重推两天）。
    if (transactionId) {
      await prisma.order.updateMany({ where: { id: order.id }, data: { paymentNo: transactionId } });
    }
    console.error(
      `[wxpay][需人工退款] 已取消订单收到支付成功通知：${outTradeNo} ` +
        `transaction=${transactionId ?? '-'} amount=${order.totalAmount}分`,
    );
    return { ok: true };
  }
  if (order.status !== 'PENDING_PAYMENT') return { ok: false, reason: `订单状态为 ${order.status}，忽略` };
  if (transactionId) {
    await prisma.order.updateMany({ where: { id: order.id }, data: { paymentNo: transactionId } });
  }
  await markOrderPaid(order.id);
  console.log(`[wxpay] 订单支付确认：${outTradeNo} transaction=${transactionId ?? '-'}`);
  return { ok: true };
}

/**
 * 云调用回调处理：主动查单核对后再落库（云托管回调无签名，必须查单防伪造）。
 * 返回 ok=false 时路由会回非 0 errcode，平台会重试。
 */
export async function handlePayNotify(outTradeNo: string): Promise<{ ok: boolean; reason?: string }> {
  const order = await prisma.order.findUnique({ where: { orderNo: outTradeNo } });
  if (!order) return { ok: false, reason: '订单不存在' };
  if (order.status === 'PAID' || order.status === 'SHIPPED' || order.status === 'COMPLETED') {
    return { ok: true };
  }
  if (order.status !== 'PENDING_PAYMENT') return { ok: false, reason: `订单状态为 ${order.status}，忽略` };

  const { paid, transactionId } = await queryOrderPaid(outTradeNo);
  if (!paid) {
    console.warn(`[wxpay] 收到回调但查单未支付：${outTradeNo}`);
    return { ok: false, reason: '查单未支付' };
  }
  return markPaidFromNotify(outTradeNo, transactionId);
}
