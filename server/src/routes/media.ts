import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { MEDIA_MAX_BYTES, readImage, saveImage } from '../services/mediaService.js';

/**
 * 商品图片素材接口。
 *
 * 分成两个路由：
 *  - /api/admin/media  上传（要商家登录态）
 *  - /api/media/:id    读图（公开）
 *
 * 读图必须公开：<img src> 带不了 Authorization 头。图片本身是商品公开素材，
 * 没有泄露风险；id 是自增的，但枚举出别人的商品图也拿不到任何额外信息。
 */
export const adminMediaRouter = Router();
export const mediaRouter = Router();

/**
 * 拼出请求方看到的那个源（含协议）。
 * 云托管在网关后，req.protocol 永远是 http，必须优先读 x-forwarded-proto，
 * 否则存进库的图片地址会变成 http://... —— 小程序与 App 都强制 https，图会裂。
 */
function requestOrigin(req: { headers: Record<string, unknown>; protocol: string }): string {
  const pick = (k: string) => {
    const v = req.headers[k];
    const raw = Array.isArray(v) ? v[0] : v;
    return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  };
  const host = pick('x-forwarded-host') || pick('host') || 'localhost';
  const proto = pick('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${host}`;
}

/** base64 后的体积约等于原图 ×4/3，1.5MB 图 ≈ 2MB 请求体，与 app.ts 的 3mb 上限对齐 */
adminMediaRouter.post(
  '/',
  validate({
    body: z.object({
      // data:image/jpeg;base64,xxxx —— 具体校验（mime 白名单、字节数）在 service 里做，
      // 这里只拦明显不是 data URL 的输入，避免把超长字符串送进正则
      dataUrl: z.string().min(24).max(MEDIA_MAX_BYTES * 2),
      width: z.number().int().min(0).max(20000).optional(),
      height: z.number().int().min(0).max(20000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as { dataUrl: string; width?: number; height?: number };
    const asset = await saveImage(body, requestOrigin(req));
    res.json({ code: 0, data: asset });
  }),
);

mediaRouter.get(
  '/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const { mime, data } = await readImage(Number(req.params.id));
    // 图片内容按 id 寻址、永不变更（换图会产生新记录），可以放心长缓存
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(data);
  }),
);
