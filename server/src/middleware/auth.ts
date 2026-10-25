import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type AuthPayload } from '../auth/jwt.js';
import { forbidden, unauthorized } from '../utils/HttpError.js';

// 鉴权中间件：requireAuth() 任意登录角色；requireAuth('merchant') 限定商家
export function requireAuth(role?: 'user' | 'merchant') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return next(unauthorized('未登录'));

    let auth: AuthPayload;
    try {
      auth = verifyToken(token);
    } catch {
      return next(unauthorized('登录态已失效'));
    }

    if (role && auth.role !== role) return next(forbidden('无权限'));
    (req as unknown as { auth: AuthPayload }).auth = auth;
    next();
  };
}