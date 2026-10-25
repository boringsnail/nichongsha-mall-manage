import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  previewOrder,
  createOrder,
  listOrders,
  getOrderDetail,
  payOrder,
  syncPayStatus,
  cancelOrder,
  confirmOrder,
} from '../services/orderService.js';

export const ordersRouter = Router();

const uid = (req: Request) => (req as unknown as { auth: { uid: number } }).auth.uid;

// 微信支付要求传用户下单 IP：优先取反代注入的 X-Forwarded-For 首段
const clientIp = (req: Request) => {
  const xff = req.header('x-forwarded-for');
  return (xff ? xff.split(',')[0].trim() : '') || req.socket.remoteAddress || '127.0.0.1';
};

const itemSchema = z.object({ skuId: z.number().int().positive(), quantity: z.number().int().min(1).max(999) });
const itemsField = z.object({ items: z.array(itemSchema).min(1) });

// 请求去重：下单 / 支付用请求 ID 防重放（同一用户 + 同一 request_id 1 分钟内只执行一次）
const requestIds = new Map<string, number>(); // key → timestamp
const IDEMPOTENT_WINDOW_MS = 60_000;

function getRequestId(req: Request): string | undefined {
  return req.headers['x-request-id'] as string | undefined;
}

function isIdempotentKeyExpired(key: string): boolean {
  const ts = requestIds.get(key);
  if (!ts || Date.now() - ts > IDEMPOTENT_WINDOW_MS) {
    requestIds.delete(key);
    return true;
  }
  return false;
}

const orderBodySchema = validate({
  body: itemsField.extend({
    addressId: z.number().int().positive(),
    remark: z.string().max(200).optional(),
    // 购物车结算=true（默认）：下单后清购物车；立即购买=false：不清
    fromCart: z.boolean().optional(),
  }),
});

const previewSchema = validate({
  body: itemsField.extend({ addressId: z.number().int().positive() }),
});

const listQuerySchema = validate({
  query: z.object({
    status: z.enum(['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED']).optional(),
    page: z.coerce.number().int().positive().optional(),
    size: z.coerce.number().int().positive().optional(),
  }),
});

const orderNoParam = validate({
  params: z.object({ orderNo: z.string().regex(/^NPA\d{16}$/) }),
});

ordersRouter.post('/preview', previewSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await previewOrder(uid(req), req.body.items, req.body.addressId) });
}));

ordersRouter.post('/', orderBodySchema, asyncHandler(async (req, res) => {
  // 防重放：同一用户 + 同一 request_id 1 分钟内只执行一次
  const rid = getRequestId(req);
  const key = rid ? `${uid(req)}:order:${rid}` : undefined;
  if (key && !isIdempotentKeyExpired(key)) {
    return res.status(429).json({ code: 'REQUEST_ALREADY_PROCESSED', message: '请勿重复提交订单' });
  }
  if (key) requestIds.set(key, Date.now());
  const result = await createOrder(uid(req), req.body.items, req.body.addressId, req.body.remark, req.body.fromCart);
  if (key) requestIds.set(key, Date.now()); // 更新过期时间
  res.json({ code: 0, data: result });
}));

ordersRouter.get('/', listQuerySchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await listOrders(uid(req), req.query) });
}));

ordersRouter.get('/:orderNo', orderNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await getOrderDetail(uid(req), req.params.orderNo) });
}));

ordersRouter.post('/:orderNo/pay', orderNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await payOrder(uid(req), req.params.orderNo, { clientIp: clientIp(req) }) });
}));

// 支付状态对账：小程序端支付成功后调用，服务端主动向微信支付查单并落库。
// 幂等——订单已支付时直接返回当前状态，不会重复累加销量。
ordersRouter.post('/:orderNo/pay-sync', orderNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await syncPayStatus(uid(req), req.params.orderNo) });
}));

ordersRouter.post('/:orderNo/cancel', orderNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await cancelOrder(uid(req), req.params.orderNo) });
}));

ordersRouter.post('/:orderNo/confirm', orderNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await confirmOrder(uid(req), req.params.orderNo) });
}));