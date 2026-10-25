import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listCategories, createCategory, updateCategory, deleteCategory } from '../services/categoryService.js';

export const adminCategoriesRouter = Router();

const idParam = validate({ params: z.object({ id: z.coerce.number().int().positive() }) });
const createSchema = validate({ body: z.object({ name: z.string().min(1), icon: z.string().optional(), sortOrder: z.number().int().optional() }) });
const updateSchema = validate({ body: z.object({ name: z.string().min(1).optional(), icon: z.string().optional(), sortOrder: z.number().int().optional() }) });

adminCategoriesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ code: 0, data: await listCategories() });
}));

adminCategoriesRouter.post('/', createSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await createCategory(req.body) });
}));

adminCategoriesRouter.put('/:id', idParam, updateSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await updateCategory(Number(req.params.id), req.body) });
}));

adminCategoriesRouter.delete('/:id', idParam, asyncHandler(async (req, res) => {
  await deleteCategory(Number(req.params.id));
  res.json({ code: 0, data: { id: Number(req.params.id) } });
}));