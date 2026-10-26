import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPublicAnnouncement } from '../services/configService.js';

/**
 * C 端公告（小程序首页顶部条）。
 *
 * 无需登录：公告本身是公开内容，登录前也要能展示。
 * 关闭或内容为空时返回 `null`，前端据此不渲染，省得再判断一次开关。
 */
export const announcementRouter = Router();

announcementRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ code: 0, data: await getPublicAnnouncement() });
  }),
);
