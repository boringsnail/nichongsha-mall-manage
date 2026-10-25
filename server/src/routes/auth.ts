import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/HttpError.js';
import { loginWithCode, loginWithOpenid, merchantLogin } from '../services/authService.js';
import { env } from '../config/env.js';

export const authRouter = Router();
export const adminAuthRouter = Router();

const codeSchema = validate({
  body: z.object({
    code: z.string().min(1),
    // 开发期 mock openid 的稳定锚点；真实微信登录下忽略
    deviceId: z.string().min(1).max(64).optional(),
  }),
});

// 登录：cloud 模式 code 可省略（身份由平台注入），直连模式仍需 code
const loginSchema = validate({
  body: z.object({
    code: z.string().min(1).optional(),
    deviceId: z.string().min(1).max(64).optional(),
  }),
});

/**
 * 读取平台注入的登录态。
 * 微信云托管用 callContainer 调服务时会注入 x-wx-openid / x-wx-source（外部伪造的请求不会两种头都带），
 * 因此要求两者同时存在才信任；需要关闭可设 TRUST_WX_HEADERS=0。
 */
function platformOpenid(req: Request): string | undefined {
  if (!env.trustWxHeaders) return undefined;
  const openid = req.header('x-wx-openid');
  const source = req.header('x-wx-source');
  return openid && source ? openid : undefined;
}

// 微信登录：
//   ① 云托管 callContainer 注入 openid → 直接建会话（零出网，推荐）
//   ② 否则用小程序 code 走 code2Session（需容器可访问 api.weixin.qq.com）
//   ③ 开发期（未配微信凭据）用 deviceId 生成 mock openid
authRouter.post('/login', loginSchema, asyncHandler(async (req, res) => {
  const openid = platformOpenid(req);
  if (openid) {
    res.json({ code: 0, data: await loginWithOpenid(openid) });
    return;
  }
  const code = req.body.code as string | undefined;
  if (!code) throw new HttpError(400, 'PARAM_ERROR', '缺少 code');
  res.json({ code: 0, data: await loginWithCode(code, req.body.deviceId) });
}));

// 开发期快捷登录：仅非生产环境挂载（生产环境必须配置微信登录，见 env.ts 启动校验）
if (env.devMode) {
  authRouter.post('/dev-login', codeSchema, asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await loginWithCode(req.body.code, req.body.deviceId) });
  }));
}

// ---------- 商家登录限流（固定窗口，按客户端标识） ----------
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LIMIT_MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

// 取限流 key：优先 X-Forwarded-For 首段（供测试/反代注入），否则回退 socket 地址
function limitKey(req: Request): string {
  const xff = req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export function adminLoginLimiter(req: Request, _res: Response, next: NextFunction) {
  const now = Date.now();
  const key = limitKey(req);
  const rec = attempts.get(key);
  if (!rec || now >= rec.resetAt) {
    attempts.set(key, { count: 0, resetAt: now + LIMIT_WINDOW_MS });
  }
  const cur = attempts.get(key)!;
  if (cur.count >= LIMIT_MAX_ATTEMPTS) {
    const waitMin = Math.max(1, Math.ceil((cur.resetAt - now) / 60000));
    return next(new HttpError(429, 'TOO_MANY_ATTEMPTS', `登录尝试次数过多，请 ${waitMin} 分钟后再试`));
  }
  cur.count += 1;
  next();
}

// 登录成功后清除该 key 计数
export function clearAdminLoginLimiter(req: Request) {
  attempts.delete(limitKey(req));
}

// 测试辅助：清空全量计数
export function resetAdminLoginLimiterForTest() {
  attempts.clear();
}

adminAuthRouter.post(
  '/login',
  adminLoginLimiter,
  validate({ body: z.object({ username: z.string().min(1), password: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const data = await merchantLogin(req.body.username, req.body.password);
    clearAdminLoginLimiter(req);
    res.json({ code: 0, data });
  })
);
