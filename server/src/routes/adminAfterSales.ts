import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  listAdminAfterSales,
  getAdminAfterSale,
  approveAfterSale,
  rejectAfterSale,
  confirmReturnReceived,
} from '../services/afterSaleService.js';

export const adminAfterSalesRouter = Router();

const afterSaleNoParam = validate({
  params: z.object({ afterSaleNo: z.string().regex(/^AS\d{16}$/) }),
});

adminAfterSalesRouter.get('/', validate({
  query: z.object({
    status: z
      .enum(['PENDING', 'AGREED', 'WAIT_RETURN', 'RETURNING', 'REFUNDING', 'COMPLETED', 'REJECTED', 'CANCELLED'])
      .optional(),
    page: z.coerce.number().int().positive().optional(),
    size: z.coerce.number().int().positive().optional(),
  }),
}), asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await listAdminAfterSales(req.query) });
}));

adminAfterSalesRouter.get('/:afterSaleNo', afterSaleNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await getAdminAfterSale(req.params.afterSaleNo) });
}));

// 同意：仅退款直接退钱；退货退款进入「待买家退货」
adminAfterSalesRouter.post('/:afterSaleNo/approve', afterSaleNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await approveAfterSale(req.params.afterSaleNo) });
}));

adminAfterSalesRouter.post('/:afterSaleNo/reject', afterSaleNoParam, validate({
  body: z.object({ reason: z.string().min(1).max(200) }),
}), asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await rejectAfterSale(req.params.afterSaleNo, req.body.reason) });
}));

// 确认收到退货 → 立即退款
adminAfterSalesRouter.post('/:afterSaleNo/receive', afterSaleNoParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await confirmReturnReceived(req.params.afterSaleNo) });
}));
