import request from 'supertest';
import express from 'express';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { notFoundHandler, errorHandler } from './error';
import { validate } from './validate';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post(
    '/api/echo',
    validate({ body: z.object({ name: z.string().min(2) }) }),
    (req, res) => res.json({ code: 0, data: req.body })
  );
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
});