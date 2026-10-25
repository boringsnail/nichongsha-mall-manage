import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listCart, addItem, updateItem, removeItem, batchCheck } from '../services/cartService.js';

export const cartRouter = Router();

const uid = (req: Request) => (req as unknown as { auth: { uid: number } }).auth.uid;

const addSchema = validate({
  body: z.object({ skuId: z.number().int().positive(), quantity: z.number().int() }),
});

const updateSchema = validate({
  body: z.object({
    quantity: z.number().int().optional(),
    checked: z.boolean().optional(),
  }).refine((v) => v.quantity != null || v.checked != null, { message: 'quantity 与 checked 至少提供一个' }),
});

const skuParam = validate({ params: z.object({ skuId: z.coerce.number().int().positive() }) });

const batchSchema = validate({ body: z.object({ checked: z.boolean() }) });

cartRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await listCart(uid(req)) });
}));

cartRouter.post('/', addSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await addItem(uid(req), req.body.skuId, req.body.quantity) });
}));

// batch 必须在 :skuId 之前声明，避免被吞
cartRouter.put('/batch/checked', batchSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await batchCheck(uid(req), req.body.checked) });
}));

cartRouter.put('/:skuId', skuParam, updateSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await updateItem(uid(req), Number(req.params.skuId), req.body) });
}));

cartRouter.delete('/:skuId', skuParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await removeItem(uid(req), Number(req.params.skuId)) });
}));
