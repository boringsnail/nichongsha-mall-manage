import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listAdminAlerts } from '../services/alertService.js';

export const adminAlertsRouter = Router();

// 管控台强提醒的数据源。前端每 20 秒轮询一次，查询只有两条小结果集 + 两个 count，
// 比让前端分别拉订单列表和售后列表便宜得多。
adminAlertsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ code: 0, data: await listAdminAlerts() });
}));
