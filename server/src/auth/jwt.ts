import jwt from 'jsonwebtoken';
import { randomInt } from 'node:crypto';
import { env } from '../config/env.js';

export interface UserPayload {
  role: 'user';
  uid: number;
}
export interface MerchantPayload {
  role: 'merchant';
  mid: number;
}
export type AuthPayload = UserPayload | MerchantPayload;

// expiresIn 兼容 jsonwebtoken 新版类型（ms.StringValue 模板字面量）
const signOptions = (expiresIn: string): jwt.SignOptions => ({
  expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
});

export function signUserToken(uid: number): string {
  return jwt.sign({ role: 'user', uid }, env.jwtSecret, signOptions(env.jwtExpiresIn));
}

export function signMerchantToken(mid: number): string {
  return jwt.sign({ role: 'merchant', mid }, env.jwtSecret, signOptions(env.jwtExpiresIn));
}

export function verifyToken(token: string): AuthPayload {
  const payload = jwt.verify(token, env.jwtSecret) as { role: string; uid?: number; mid?: number };
  if (payload.role === 'user' && payload.uid != null) return { role: 'user', uid: payload.uid };
  if (payload.role === 'merchant' && payload.mid != null) return { role: 'merchant', mid: payload.mid };
  throw new Error('invalid token payload');
}

/** 加密安全的 4 位随机数字（0000~9999），用于订单号 */
export function secureRandomFour(): string {
  const r = randomInt(0, 10000);
  return String(r).padStart(4, '0');
}