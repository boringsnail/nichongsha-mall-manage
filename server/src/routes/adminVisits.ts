import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { visitOverview, viewLogs, loginLogs, cartItems } from '../services/visitService.js';

/**
 * 「用户访问」：商品浏览 / 登录 / 购物车。
 *
 * 只读接口 —— 这里是给商家「看」的，不提供任何修改能力：
 * 购物车是用户的东西，后台能看不能改。
 */
export const adminVisitsRouter = Router();

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const pageQuery = daysQuery.extend({
  /** 点某一行按用户下钻：只传 userId 就能只看这个人的流水 */
  userId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

adminVisitsRouter.get(
  '/overview',
  validate({ query: daysQuery }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await visitOverview(Number(req.query.days)) });
  })
);

adminVisitsRouter.get(
  '/views',
  validate({ query: pageQuery }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await viewLogs(req.query as never) });
  })
);

adminVisitsRouter.get(
  '/logins',
  validate({ query: pageQuery }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await loginLogs(req.query as never) });
  })
);

// 购物车没有时间窗：它是「此刻还没结算的东西」，翻历史没有意义
adminVisitsRouter.get(
  '/carts',
  validate({
    query: z.object({
      userId: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().positive().default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await cartItems(req.query as never) });
  })
);
