import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { hashPassword } from '../auth/password';

beforeEach(async () => {
  // 先删引用 user 的依赖表，避免跨文件残留订单触发外键约束
  await prisma.address.deleteMany();
  await prisma.orderItem.deleteMany();
  // 售后单引用 Order/User，必须先删，否则外键约束会挡住
  await prisma.afterSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.merchant.deleteMany();
  await prisma.merchant.create({
    data: { username: 'merchant', passwordHash: await hashPassword('商家123'), nickname: '掌柜' },
  });
});

describe('微信登录（dev-login）', () => {
  it('返回 token 且用户幂等创建', async () => {
    const app = createApp();
    const r1 = await request(app).post('/api/auth/dev-login').send({ code: 'abc' });
    expect(r1.status).toBe(200);
    expect(r1.body.code).toBe(0);
    expect(r1.body.data.token).toBeTruthy();
    expect(r1.body.data.user.id).toBeGreaterThan(0);

    const r2 = await request(app).post('/api/auth/dev-login').send({ code: 'abc' });
    expect(r2.body.data.user.id).toBe(r1.body.data.user.id);
    expect(await prisma.user.count()).toBe(1);
  });

  // I3：真实 wx.login 的 code 每次不同；mock 期必须以稳定 deviceId 锚定同一账号
  it('同一 deviceId 不同 code → 同一用户；不同 deviceId → 不同用户', async () => {
    const app = createApp();
    const a = await request(app).post('/api/auth/login').send({ code: 'code-1', deviceId: 'device-A' });
    expect(a.status).toBe(200);
    const b = await request(app).post('/api/auth/login').send({ code: 'code-2', deviceId: 'device-A' });
    expect(b.body.data.user.id).toBe(a.body.data.user.id);

    const c = await request(app).post('/api/auth/login').send({ code: 'code-3', deviceId: 'device-B' });
    expect(c.status).toBe(200);
    expect(c.body.data.user.id).not.toBe(a.body.data.user.id);
    expect(await prisma.user.count()).toBe(2);
  });
});

describe('商家登录', () => {
  it('正确密码 → token + merchant', async () => {
    const res = await request(createApp())
      .post('/api/admin/auth/login')
      .send({ username: 'merchant', password: '商家123' });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.merchant.username).toBe('merchant');
  });

  it('错误密码 → 401 NOT_AUTH', async () => {
    const res = await request(createApp())
      .post('/api/admin/auth/login')
      .send({ username: 'merchant', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NOT_AUTH');
  });
});