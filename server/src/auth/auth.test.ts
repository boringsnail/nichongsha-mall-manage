import request from 'supertest';
import express from 'express';
import { describe, it, expect, beforeAll } from 'vitest';
import { signUserToken, signMerchantToken, verifyToken } from './jwt';
import { hashPassword, verifyPassword } from './password';
import { requireAuth } from '../middleware/auth';
import { errorHandler } from '../middleware/error';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/me', requireAuth('user'), (req, res) => {
    res.json({ code: 0, data: { uid: (req as any).auth.uid } });
  });
  app.get('/api/admin/x', requireAuth('merchant'), (_req, res) => {
    res.json({ code: 0, data: { ok: true } });
  });
  app.use(errorHandler);
  return app;
}

describe('JWT 签发与验证', () => {
  it('user 令牌 roundtrip', () => {
    const t = signUserToken(7);
    const payload = verifyToken(t);
    expect(payload).toEqual({ role: 'user', uid: 7 });
  });
  it('merchant 令牌 roundtrip', () => {
    const t = signMerchantToken(3);
    const payload = verifyToken(t);
    expect(payload).toEqual({ role: 'merchant', mid: 3 });
  });
});

describe('密码工具', () => {
  it('hash/verify 往返通过，错误密码失败', async () => {
    const hash = await hashPassword('商家123');
    expect(hash).not.toBe('商家123');
    expect(await verifyPassword('商家123', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('requireAuth 鉴权中间件', () => {
  it('无 token → 401 NOT_AUTH', async () => {
    const res = await request(buildApp()).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NOT_AUTH');
  });
  it('坏 token → 401', async () => {
    const res = await request(buildApp()).get('/api/me').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
  });
  it('user token 访问 merchant 接口 → 403 FORBIDDEN', async () => {
    const t = signUserToken(1);
    const res = await request(buildApp()).get('/api/admin/x').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
  it('正确角色通过并注入 auth', async () => {
    const t = signUserToken(9);
    const res = await request(buildApp()).get('/api/me').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body.data.uid).toBe(9);
  });
});