import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signUserToken } from '../auth/jwt';
import { __resetRateLimiter } from './track';

beforeEach(async () => {
  await prisma.userEvent.deleteMany();
  await prisma.user.deleteMany();
  // 限流按 IP 累计，测试同源 127.0.0.1，必须逐例清空窗口
  __resetRateLimiter();
});

afterEach(() => {
  delete process.env.TRACK_RATE_LIMIT;
});

describe('埋点上报 POST /api/track', () => {
  it('游客上报：无 token 也可，落库且 userId 为空', async () => {
    const res = await request(createApp())
      .post('/api/track')
      .send({ eventType: 'app_launch', sessionId: 'sess-1' });
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(true);

    const rows = await prisma.userEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('app_launch');
    expect(rows[0].sessionId).toBe('sess-1');
    expect(rows[0].userId).toBeNull();
  });

  it('带 token 上报：自动关联 userId 与 openid', async () => {
    const u = await prisma.user.create({ data: { openid: 'openid-track-1', nickname: '测试' } });
    const token = signUserToken(u.id);

    await request(createApp())
      .post('/api/track')
      .set('Authorization', `Bearer ${token}`)
      .send({ eventType: 'product_view', sessionId: 'sess-2', productId: 9 });

    const row = await prisma.userEvent.findFirst({ where: { eventType: 'product_view' } });
    expect(row?.userId).toBe(u.id);
    expect(row?.openid).toBe('openid-track-1');
    expect(row?.productId).toBe(9);
  });

  it('token 失效按游客处理，不报错（埋点不能影响主流程）', async () => {
    const res = await request(createApp())
      .post('/api/track')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ eventType: 'app_launch', sessionId: 'sess-3' });
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(true);
    const row = await prisma.userEvent.findFirst();
    expect(row?.userId).toBeNull();
  });

  it('非法 eventType 被拒（400），不污染统计', async () => {
    const res = await request(createApp()).post('/api/track').send({ eventType: 'hack_event' });
    expect(res.status).toBe(400);
    expect(await prisma.userEvent.count()).toBe(0);
  });

  it('缺少 eventType 被拒（400）', async () => {
    const res = await request(createApp()).post('/api/track').send({ sessionId: 'x' });
    expect(res.status).toBe(400);
  });

  it('订单类事件可带 orderNo 与金额', async () => {
    await request(createApp())
      .post('/api/track')
      .send({ eventType: 'pay_success', sessionId: 'sess-4', orderNo: 'NPA1234567890123456', amount: 9900 });
    const row = await prisma.userEvent.findFirst({ where: { eventType: 'pay_success' } });
    expect(row?.orderNo).toBe('NPA1234567890123456');
    expect(row?.amount).toBe(9900);
  });

  it('限流：超过窗口上限后静默丢弃（accepted=false）而非报错', async () => {
    process.env.TRACK_RATE_LIMIT = '3';
    const app = createApp();
    const send = () => request(app).post('/api/track').send({ eventType: 'app_launch', sessionId: 's' });

    const r1 = await send();
    const r2 = await send();
    const r3 = await send();
    const r4 = await send();

    // 前 3 条接收，第 4 条被限流但仍返回 200 且 accepted=false（不打扰端上）
    expect(r1.body.data.accepted).toBe(true);
    expect(r3.body.data.accepted).toBe(true);
    expect(r4.status).toBe(200);
    expect(r4.body.data.accepted).toBe(false);
    // 只有 3 条真正落库
    expect(await prisma.userEvent.count()).toBe(3);
  });
});
