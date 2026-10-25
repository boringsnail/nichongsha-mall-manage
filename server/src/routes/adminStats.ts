import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { overview, topProducts, lowStock, trend, funnel, advice } from '../services/statsService.js';

export const adminStatsRouter = Router();

adminStatsRouter.get('/overview', asyncHandler(async (_req, res) => {
  res.json({ code: 0, data: await overview() });
}));

adminStatsRouter.get(
  '/top-products',
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await topProducts(Number(req.query.days), Number(req.query.limit)) });
  })
);

adminStatsRouter.get(
  '/low-stock',
  validate({
    query: z.object({ threshold: z.coerce.number().int().min(0).default(10) }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await lowStock(Number(req.query.threshold)) });
  })
);

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

adminStatsRouter.get(
  '/trend',
  validate({ query: daysQuery }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await trend(Number(req.query.days)) });
  })
);

adminStatsRouter.get(
  '/funnel',
  validate({ query: daysQuery }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await funnel(Number(req.query.days)) });
  })
);

adminStatsRouter.get(
  '/advice',
  validate({ query: daysQuery }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await advice(Number(req.query.days)) });
  })
);
