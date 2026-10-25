import request from 'supertest';
import express from 'express';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { notFoundHandler, errorHandler, describeError } from './error';
import { validate } from './validate';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post(
    '/api/echo',
    validate({ body: z.object({ name: z.string().min(2) }) }),
    (req, res) => res.json({ code: 0, data: req.body })
  );
  // 未预期异常（非 HttpError）走 500 兜底
  app.get('/api/admin/boom', () => {
    throw new Error('"expiresIn" should be a number of seconds');
  });
  app.get('/api/boom', () => {
    throw new Error('secret internal failure');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('统一错误体系', () => {
  it('未知路由 → 404 NOT_FOUND', async () => {
    const res = await request(buildApp()).get('/api/nothing');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('校验通过 → 200 code 0', async () => {
    const res = await request(buildApp()).post('/api/echo').send({ name: 'abc' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.name).toBe('abc');
  });

  it('校验失败 → 400 PARAM_ERROR 且带字段信息', async () => {
    const res = await request(buildApp()).post('/api/echo').send({ name: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PARAM_ERROR');
    expect(res.body.message).toContain('name');
  });

  it('管控台 500 → 带上真实原因，便于自查', async () => {
    const res = await request(buildApp()).get('/api/admin/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SERVER_ERROR');
    expect(res.body.message).toContain('服务器开小差了');
    expect(res.body.message).toContain('expiresIn');
  });

  it('C 端 500 → 只给通用文案，不暴露内部细节', async () => {
    const res = await request(buildApp()).get('/api/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SERVER_ERROR');
    expect(res.body.message).toBe('服务器开小差了');
  });

  it('describeError 会脱敏连接串密码并截断超长信息', () => {
    const masked = describeError(new Error('connect mysql://nichongsha:Nichongsha334-@10.26.101.236:3306/nichongsha'));
    expect(masked).not.toContain('Nichongsha334-');
    expect(masked).toContain('***');
    expect(describeError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(201);
  });
});