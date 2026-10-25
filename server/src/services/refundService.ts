import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { payProvider } from './payService.js';

// 退款执行层：只负责「把钱退回去 + 落库」这一件事，不理解售后业务状态。
// 业务状态机在 afterSaleService 里，避免把「业务规则」和「资金操作」耦在一起。

export type RefundOutcome =
  | { ok: true; refundNo: string; /** SUCCESS=已到账 / PROCESSING=处理中 */ status: string }
  | { ok: false; /** 需要人工介入（金额异常、商户余额不足等） */ needsManual: boolean; error: string };

/** 微信退款单号生成：同一售后重试必须复用同一个，保证幂等（重复退款会退两次钱） */
export function refundOutNoFor(afterSaleNo: string): string {
  return afterSaleNo;
}

/**
 * 执行退款。
 *
 * 幂等设计：
 *  - out_refund_no 用售后单号，同一笔售后无论重试多少次，微信侧只会有一笔退款；
 *  - 微信对重复的 out_refund_no 会返回原退款单（不会重复退），因此可安全重试。
 *
 * 金额校验：本次退款金额不得超过「订单实付 - 已退金额」，否则属于超额退款，
 * 直接拒绝并要求人工核对（这是资损红线，不能靠重试）。
 */
export async function executeRefund(input: {
  orderNo: string;
  afterSaleNo: string;
  totalFee: number;
  refundFee: number;
  alreadyRefunded: number;
  reason?: string;
}): Promise<RefundOutcome> {
  const { orderNo, afterSaleNo, totalFee, refundFee, alreadyRefunded } = input;

  if (!Number.isInteger(refundFee) || refundFee <= 0) {
    return { ok: false, needsManual: true, error: `退款金额非法：${refundFee}` };
  }
  if (alreadyRefunded + refundFee > totalFee) {
    return {
      ok: false,
      needsManual: true,
      error: `超额退款：已退 ${alreadyRefunded} + 本次 ${refundFee} > 订单实付 ${totalFee}`,
    };
  }

  // 开发环境（mock）没有真实商户号，直接视为退款成功，方便本地跑通流程
  if (payProvider() !== 'wechatpay-direct') {
    console.log(`[refund][mock] 模拟退款成功 ${orderNo} 金额=${refundFee} 售后=${afterSaleNo}`);
    return { ok: true, refundNo: `MOCK${afterSaleNo}`, status: 'SUCCESS' };
  }

  try {
    const { applyRefund } = await import('./wechatpayV3Service.js');
    const res = await applyRefund({
      orderNo,
      outRefundNo: refundOutNoFor(afterSaleNo),
      totalFee,
      refundFee,
      reason: input.reason,
    });
    if (!res.status) {
      return { ok: false, needsManual: false, error: '微信未返回退款状态' };
    }
    if (res.status === 'ABNORMAL' || res.status === 'CLOSED') {
      // ABNORMAL 常见于用户银行卡注销、账户异常，需要人工介入换渠道退款
      console.error(
        `[refund][需人工] 微信退款状态异常 ${orderNo} 售后=${afterSaleNo} status=${res.status} refund=${refundFee}`,
      );
      return { ok: false, needsManual: true, error: `微信退款状态 ${res.status}` };
    }
    console.log(
      `[refund] 退款受理成功 ${orderNo} 售后=${afterSaleNo} refundId=${res.refundId ?? '-'} status=${res.status}`,
    );
    return { ok: true, refundNo: res.refundId || refundOutNoFor(afterSaleNo), status: res.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 余额不足 / 参数错误这类要人工处理；网络抖动可以重试
    const needsManual = /NOT_ENOUGH|BALANCE|PARAM_ERROR|INVALID_REQUEST|超额|账户/i.test(message);
    console.error(`[refund] 退款失败 ${orderNo} 售后=${afterSaleNo}: ${message}`);
    return { ok: false, needsManual, error: message };
  }
}

/** 查询退款单真实状态（回调丢失时的兜底） */
export async function probeRefund(afterSaleNo: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  if (payProvider() !== 'wechatpay-direct') return { ok: true, status: 'SUCCESS' };
  try {
    const { queryRefund } = await import('./wechatpayV3Service.js');
    const res = await queryRefund(refundOutNoFor(afterSaleNo));
    return { ok: true, status: res.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[refund-probe] 查询退款失败 ${afterSaleNo}: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * 退款成功后落库（幂等）：
 *  - 售后单置为 COMPLETED，写 refundedAt / refundNo / refundedAmount；
 *  - 订单累加 refundedAmount；全额退款时订单状态保持（订单本身已完成），
 *    但打上退款标记，便于对账。
 *
 * 用条件更新（status = REFUNDING）保证同一笔退款只落库一次——回调与主动查询
 * 可能同时到达，重复累加会把 refundedAmount 算成两倍。
 */
export async function markRefunded(
  afterSaleNo: string,
  info: { refundNo?: string; refundFee?: number },
): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
  if (!row) return { ok: false, changed: false, reason: '售后单不存在' };

  // 已完成：幂等返回，不再累加金额
  if (row.status === 'COMPLETED') return { ok: true, changed: false };

  const amount = typeof info.refundFee === 'number' && info.refundFee > 0 ? info.refundFee : row.refundAmount;
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.afterSale.updateMany({
      where: { afterSaleNo, status: { in: ['REFUNDING', 'AGREED', 'RETURNING', 'WAIT_RETURN'] } },
      data: {
        status: 'COMPLETED',
        refundedAt: now,
        refundedAmount: amount,
        refundNo: info.refundNo ?? row.refundNo,
      },
    });
    if (updated.count !== 1) return false;
    await tx.order.update({
      where: { id: row.orderId },
      data: { refundedAmount: { increment: amount }, afterSaleStatus: 'COMPLETED' },
    });
    return true;
  });

  if (!result) {
    // 抢输了：说明另一个路径已经落库
    const fresh = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    return { ok: fresh?.status === 'COMPLETED', changed: false };
  }
  console.log(`[refund] 已落库 ${afterSaleNo} 金额=${amount} 订单=${row.orderNo}`);
  return { ok: true, changed: true };
}

/** 退款失败但不需要人工（可重试）时把售后单退回可重试状态，避免卡在「退款中」 */
export async function markRefundRetryable(afterSaleNo: string, reason: string): Promise<void> {
  await prisma.afterSale.updateMany({
    where: { afterSaleNo, status: 'REFUNDING' },
    data: { status: 'AGREED' },
  });
  console.warn(`[refund] 退款可重试，售后单退回已同意 ${afterSaleNo}: ${reason}`);
}

/** 退款需要人工介入：保持 REFUNDING 并打日志，等运营在后台处理（避免自动重试刷接口） */
export async function markRefundManual(afterSaleNo: string, reason: string): Promise<void> {
  console.error(`[refund][需人工处理] 售后单 ${afterSaleNo} 保持「退款中」，请人工核对：${reason}`);
}

/** 是否已配置真实退款能力（用于决定是否展示「原路退回」等文案） */
export function isRefundConfigured(): boolean {
  return payProvider() === 'wechatpay-direct' && Boolean(env.pay.direct.mchid);
}
