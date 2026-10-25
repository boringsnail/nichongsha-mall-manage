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
  body: z
    .object({
      // 物流模式：1 快递发货 / 2 同城配送 / 4 用户自提（3 虚拟商品本项目不使用）
      // 缺省按快递处理，兼容老版前端只传公司与单号的请求
      logisticsType: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
      logisticsCompany: z.string().trim().max(64).optional(),
      trackingNo: z.string().trim().max(128).optional(),
    })
    .superRefine((val, ctx) => {
      if (val.logisticsType !== 1) return;
      if (!val.logisticsCompany) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['logisticsCompany'], message: '快递发货需要填写物流公司' });
      }
      if (!val.trackingNo) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trackingNo'], message: '快递发货需要填写物流单号' });
      }
    }),
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
