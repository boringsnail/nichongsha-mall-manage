import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  applyAfterSale,
  listMyAfterSales,
  getMyAfterSale,
  cancelAfterSale,
  submitReturnTracking,
  AFTER_SALE_REASONS,
} from '../services/afterSaleService.js';

export const afterSalesRouter = Router();

const uid = (req: Request) => (req as unknown as { auth: { uid: number } }).auth.uid;

const REASON_KEYS = Object.keys(AFTER_SALE_REASONS) as [keyof typeof AFTER_SALE_REASONS, ...Array<keyof typeof AFTER_SALE_REASONS>];

const afterSaleNoParam = validate({
  params: z.object({ afterSaleNo: z.string().regex(/^AS\d{16}$/) }),
});

const applySchema = validate({
  body: z.object({
    orderNo: z.string().regex(/^NPA\d{16}$/),
    type: z.enum(['REFUND_ONLY', 'RETURN_REFUND']),
    reason: z.enum(REASON_KEYS),
    description: z.string().max(500).optional(),
    images: z.array(z.string().max(512)).max(6).optional(),
    // 单位：分。不传则默认「订单可退全额」
    refundAmount: z.number().int().positive().optional(),
  }),
});

/** 售后原因清单：小程序申请页直接用这份，避免前后端文案/枚举漂移 */
afterSalesRouter.get('/reasons', (_req, res) => {
  res.json({
    code: 0,
    data: Object.entries(AFTER_SALE_REASONS).map(([key, text]) => ({ key, text })),
  });
});

afterSalesRouter.post('/', applySchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await applyAfterSale(uid(req), req.body) });
}));

afterSalesRouter.get('/', validate({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    size: z.coerce.number().int().positive().optional(),
  }),
}), asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await listMyAfterSales(uid(req), req.query) });
}));

afterSalesRouter.get('/:afterSaleNo', afterSaleNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await getMyAfterSale(uid(req), req.params.afterSaleNo) });
}));

// 撤销申请：已提交退款的不能撤（钱已经在路上）
afterSalesRouter.post('/:afterSaleNo/cancel', afterSaleNoParam, validate({
  body: z.object({ reason: z.string().max(200).optional() }).optional(),
}), asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await cancelAfterSale(uid(req), req.params.afterSaleNo, req.body?.reason) });
}));

// 填写退货物流单号（退货退款专用）
afterSalesRouter.post('/:afterSaleNo/return', afterSaleNoParam, validate({
  body: z.object({
    logisticsCompany: z.string().min(1).max(32),
    trackingNo: z.string().min(1).max(64),
  }),
}), asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await submitReturnTracking(uid(req), req.params.afterSaleNo, req.body) });
}));
