import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { handlePayNotify, markPaidFromNotify, payProvider } from '../services/payService.js';
import { verifyAndDecryptNotify, verifyAndDecryptRefundNotify } from '../services/wechatpayV3Service.js';
import { markRefunded } from '../services/refundService.js';

// 支付结果回调。兼容两种协议：
//   ① 微信支付 APIv3 直连通知：带 Wechatpay-* 签名头，需验签 + AES-GCM 解密；
//      期望响应 HTTP 200 + {"code":"SUCCESS"}（微信文档：通知应答协议）。
//   ② 微信云托管云调用回调：平台内部推送，无签名头；必须返回 {"errcode":0}，否则两天内持续重试。
// 安全：两种协议都不会盲信回调——① 靠平台公钥验签，② 靠主动查单核对。
export const payRouter = Router();

/** APIv3 直连通知处理 */
async function handleV3Notify(req: Request, res: Response) {
  const rawBody =
    (req as unknown as { rawBody?: string }).rawBody ?? (req.body ? JSON.stringify(req.body) : '');
  let decrypted: Record<string, unknown>;
  try {
    decrypted = verifyAndDecryptNotify(rawBody, {
      timestamp: req.header('wechatpay-timestamp'),
      nonce: req.header('wechatpay-nonce'),
      signature: req.header('wechatpay-signature'),
      serial: req.header('wechatpay-serial'),
    });
  } catch (error) {
    // 验签/解密失败：返回非成功，微信会重试；同时记录便于排障
    console.error('[wxpay-v3] 支付通知校验失败:', error);
    res.status(401).json({ code: 'FAIL', message: 'signature or decrypt failed' });
    return;
  }

  const outTradeNo = String(decrypted.out_trade_no ?? '');
  const tradeState = String(decrypted.trade_state ?? '');
  const transactionId = decrypted.transaction_id ? String(decrypted.transaction_id) : undefined;

  if (!outTradeNo) {
    console.warn('[wxpay-v3] 通知缺少 out_trade_no:', JSON.stringify(decrypted).slice(0, 300));
    res.status(400).json({ code: 'FAIL', message: 'missing out_trade_no' });
    return;
  }
  if (tradeState !== 'SUCCESS') {
    // 非成功状态无需落库，直接应答避免重试
    console.log(`[wxpay-v3] 通知状态非 SUCCESS：${outTradeNo} state=${tradeState}`);
    res.json({ code: 'SUCCESS', message: '成功' });
    return;
  }

  const result = await markPaidFromNotify(outTradeNo, transactionId);
  if (result.ok) {
    res.json({ code: 'SUCCESS', message: '成功' });
    return;
  }
  console.error(`[wxpay-v3] 通知处理未成功：${outTradeNo} reason=${result.reason}`);
  res.status(500).json({ code: 'FAIL', message: result.reason ?? 'handle failed' });
}

payRouter.post('/notify', asyncHandler(async (req, res) => {
  // ① APIv3 直连通知（微信支付服务器直接回调我们的公网地址）
  if (req.header('wechatpay-signature')) {
    await handleV3Notify(req, res);
    return;
  }

  // ② 微信云托管云调用回调
  const body = (req.body ?? {}) as Record<string, unknown>;
  const outTradeNo = String(body.outTradeNo ?? body.out_trade_no ?? '');

  if (!outTradeNo) {
    console.warn(`[wxpay] 回调缺少 outTradeNo（provider=${payProvider()}）:`, JSON.stringify(body).slice(0, 300));
    res.json({ errcode: 400, errmsg: 'missing outTradeNo' });
    return;
  }

  try {
    const result = await handlePayNotify(outTradeNo);
    if (result.ok) {
      res.json({ errcode: 0, errmsg: 'ok' });
      return;
    }
    console.warn(`[wxpay] 回调未确认：${outTradeNo} reason=${result.reason}`);
    res.json({ errcode: 500, errmsg: result.reason ?? 'not confirmed' });
  } catch (error) {
    // 抛出去会变成 500 HTML/JSON 不一致，这里仍按回调协议返回 JSON，让平台重试
    console.error('[wxpay] 回调处理异常:', error);
    res.json({ errcode: 500, errmsg: 'handle failed' });
  }
}));

/**
 * 退款结果回调（APIv3）。
 *
 * 为什么必须有：退款到账是异步的，微信只通过这个回调告知结果；不接这个回调，
 * 售后单会永远停在「退款中」，用户看不到钱到账。回调验签同支付回调。
 *
 * 注意：退款失败的场景（ABNORMAL/CLOSED）也走这里，必须如实记录并打告警——
 * 钱没退出去但系统显示已退款是最严重的客诉来源。
 */
payRouter.post('/refund-notify', asyncHandler(async (req, res) => {
  const rawBody =
    (req as unknown as { rawBody?: string }).rawBody ?? (req.body ? JSON.stringify(req.body) : '');

  let info: ReturnType<typeof verifyAndDecryptRefundNotify>;
  try {
    info = verifyAndDecryptRefundNotify(rawBody, {
      timestamp: req.header('wechatpay-timestamp'),
      nonce: req.header('wechatpay-nonce'),
      signature: req.header('wechatpay-signature'),
      serial: req.header('wechatpay-serial'),
    });
  } catch (error) {
    console.error('[wxpay-v3] 退款通知校验失败:', error);
    res.status(401).json({ code: 'FAIL', message: 'signature or decrypt failed' });
    return;
  }

  const outRefundNo = info.outRefundNo;
  if (!outRefundNo) {
    console.warn('[wxpay-v3] 退款通知缺少 out_refund_no:', JSON.stringify(info).slice(0, 300));
    res.status(400).json({ code: 'FAIL', message: 'missing out_refund_no' });
    return;
  }

  // 售后单号就是 out_refund_no（refundService.refundOutNoFor）
  if (info.refundStatus === 'SUCCESS') {
    const result = await markRefunded(outRefundNo, { refundNo: info.refundId, refundFee: info.refundFee });
    if (result.ok) {
      res.json({ code: 'SUCCESS', message: '成功' });
      return;
    }
    console.error(`[wxpay-v3] 退款通知处理失败 ${outRefundNo}: ${result.reason ?? 'unknown'}`);
    // 返回失败让微信重试（售后单可能还没建好/状态未到 REFUNDING）
    res.status(500).json({ code: 'FAIL', message: result.reason ?? 'handle failed' });
    return;
  }

  // 非 SUCCESS：ABNORMAL 需要人工介入，CLOSED 视为退款终止
  console.error(
    `[wxpay-v3][需人工] 退款未成功 ${outRefundNo} status=${info.refundStatus} refund=${info.refundFee ?? '-'}`,
  );
  res.json({ code: 'SUCCESS', message: '已记录' });
}));
