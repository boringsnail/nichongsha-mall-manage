import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  overview,
  topProducts,
  lowStock,
  trend,
  funnel,
  advice,
  revenue,
  productTrend,
} from '../services/statsService.js';
import { searchStats, searchLogs } from '../services/searchStatsService.js';

export const adminStatsRouter = Router();

adminStatsRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    res.json({ code: 0, data: await overview() });
  })
);

// 大盘的 7 / 30 / 90 天切换；营收、趋势、漏斗、建议共用这一个参数
const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

adminStatsRouter.get(
  '/revenue',
  validate({ query: daysQuery }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await revenue(Number(req.query.days)) });
  })
);

// 商品销量 TOP N：支持 30 天 / 90 天 / 1 年，N 由前端选（默认 10）
adminStatsRouter.get(
  '/top-products',
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await topProducts(Number(req.query.days), Number(req.query.limit)) });
  })
);

// 点开某个商品看它的售卖趋势
adminStatsRouter.get(
  '/product-trend',
  validate({
    query: z.object({
      productId: z.coerce.number().int().positive(),
      days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    const data = await productTrend(Number(req.query.productId), Number(req.query.days));
    if (!data) {
      res.status(404).json({ code: 'NOT_FOUND', message: '商品不存在' });
      return;
    }
    res.json({ code: 0, data });
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

// 搜索分析总览（热搜词 / 无结果词 / 趋势 / 按用户聚合）
adminStatsRouter.get(
  '/search',
  validate({
    query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await searchStats(Number(req.query.days)) });
  })
);

// 搜索明细（可按 userId / keyword 过滤）：点某个用户看他的完整搜索记录
adminStatsRouter.get(
  '/search/logs',
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      userId: z.coerce.number().int().positive().optional(),
      keyword: z.string().trim().max(64).optional(),
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({
      code: 0,
      data: await searchLogs({
        days: Number(req.query.days),
        userId: req.query.userId ? Number(req.query.userId) : undefined,
        keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
        page: Number(req.query.page),
        size: Number(req.query.size),
      }),
    });
  })
);
