import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from './app';

describe('health', () => {
  it('GET /api/health 返回 ok', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: 0, data: { status: 'ok' } });
  });

  // 云托管默认探活路径多为 `/`，非 2xx 会被判「启动检查失败 → 部署失败」
  it('GET / 返回 200（平台探活兜底）', async () => {
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: 0, data: { service: 'nichongsha-api', status: 'ok' } });
  });

  it('GET /healthz 返回 ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ok');
  });

  it('HEAD / 也能通过（部分探针用 HEAD）', async () => {
    const res = await request(createApp()).head('/');
    expect(res.status).toBe(200);
  });
});
