import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { updateSku, setSkuStock, listSkus } from '../services/productService.js';

export const adminSkusRouter = Router();

// 库存管理列表：按 SKU 行分页（total=SKU 数），keyword 匹配商品名/规格名
adminSkusRouter.get(
  '/',
  validate({
    query: z.object({
      keyword: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      size: z.coerce.number().int().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await listSkus(req.query) });
  })
);

adminSkusRouter.put(
  '/:id',
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ specName: z.string().min(1).optional(), price: z.number().int().min(0).optional() }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await updateSku(Number(req.params.id), req.body) });
  })
);

adminSkusRouter.put(
  '/:id/stock',
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({ stock: z.number().int().min(0) }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await setSkuStock(Number(req.params.id), req.body.stock) });
  })
);