import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listAdminOrders, getAdminOrderDetail, shipOrder } from '../services/adminOrderService.js';

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
