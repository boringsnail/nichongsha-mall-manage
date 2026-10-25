import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listAdminOrders, getAdminOrderDetail, shipOrder, syncAdminOrderFromWechat, syncAdminOrdersFromWechat } from '../services/adminOrderService.js';
import { diagnoseWechatOrder } from '../services/shippingService.js';

export const adminOrdersRouter = Router();

const listQuerySchema = validate({
  query: z.object({
    status: z.enum(['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED']).optional(),
    page: z.coerce.number().int().positive().optional(),
    size: z.coerce.number().int().positive().optional(),
  }),
});

const shipSchema = validate({
  params: z.object({ orderNo: z.string().regex(/^NPA\d{16}$/) }),
  body: z.object({ logisticsCompany: z.string().min(1), trackingNo: z.string().min(1) }),
});

adminOrdersRouter.get('/', listQuerySchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await listAdminOrders(req.query) });
}));

adminOrdersRouter.get('/:orderNo', validate({ params: z.object({ orderNo: z.string().regex(/^NPA\d{16}$/) }) }), asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await getAdminOrderDetail(req.params.orderNo) });
}));

adminOrdersRouter.post('/:orderNo/ship', shipSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await shipOrder(req.params.orderNo, req.body) });
}));

// 手动对账：把微信侧（商家可能是在微信后台发的货）的履约状态拉回本地
adminOrdersRouter.post('/sync-wx', asyncHandler(async (_req, res) => {
  res.json({ code: 0, data: await syncAdminOrdersFromWechat() });
}));

adminOrdersRouter.post(
  '/:orderNo/sync-wx',
  validate({ params: z.object({ orderNo: z.string().regex(/^NPA\d{16}$/) }) }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await syncAdminOrderFromWechat(req.params.orderNo) });
  }),
);

// 微信接口自检：逐段暴露 appid/secret/mchid 是否配好、能否拿到 access_token、
// get_order 的真实返回。排障用，只读且不含密钥。
adminOrdersRouter.get(
  '/:orderNo/wx-diagnose',
  validate({ params: z.object({ orderNo: z.string().regex(/^NPA\d{16}$/) }) }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await diagnoseWechatOrder(req.params.orderNo) });
  }),
);
