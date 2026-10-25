import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listCategories } from '../services/categoryService.js';
import { listPublicProducts, getPublicProduct } from '../services/productService.js';

export const productsRouter = Router();
export const categoriesRouter = Router();

categoriesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ code: 0, data: await listCategories() });
}));

productsRouter.get(
  '/',
  validate({
    query: z.object({
      categoryId: z.coerce.number().int().positive().optional(),
      keyword: z.string().optional(),
      sort: z.enum(['price', 'sales', 'new']).optional(),
      page: z.coerce.number().int().positive().optional(),
      size: z.coerce.number().int().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await listPublicProducts(req.query) });
  })
);

productsRouter.get(
  '/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await getPublicProduct(Number(req.params.id)) });
  })
);