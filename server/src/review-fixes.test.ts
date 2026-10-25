// 代码审查回归：m6 非法 JSON、m7 登录限流、m9 SKU 列表、C2/I6 生产环境门控
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from './app';
import { prisma } from './db';
import { hashPassword } from './auth/password';
import { signMerchantToken } from './auth/jwt';
import { resetAdminLoginLimiterForTest } from './routes/auth';

beforeEach(async () => {
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
  resetAdminLoginLimiterForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('审查修复回归', () => {
  it('非法 JSON 请求体 → 400 PARAM_ERROR 而非 500（m6）', async () => {
    const res = await request(createApp())
      .post('/api/auth/dev-login')
      .set('Content-Type', 'application/json')
      .send('{broken json');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PARAM_ERROR');
  });

  it('商家登录限流：同源 11 次 → 429 TOO_MANY_ATTEMPTS（m7）', async () => {
    const app = createApp();
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post('/api/admin/auth/login')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({ username: 'merchant', password: 'wrong' });
      expect(r.status).toBe(401);
    }
    const blocked = await request(app)
      .post('/api/admin/auth/login')
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ username: 'merchant', password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('限流窗口内登录成功 → 计数复位，不误伤后续请求（m7）', async () => {
    await prisma.merchant.create({ data: { username: 'merchant', passwordHash: await hashPassword('商家123') } });
    const app = createApp();
    // 9 次失败（第 9 次后 count=9，未触顶）
    for (let i = 0; i < 9; i++) {
      const r = await request(app)
        .post('/api/admin/auth/login')
        .set('X-Forwarded-For', '198.51.100.9')
        .send({ username: 'merchant', password: 'wrong' });
      expect(r.status).toBe(401);
    }
    // 第 10 次正确密码：成功 → 计数清空
    const ok = await request(app)
      .post('/api/admin/auth/login')
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ username: 'merchant', password: '商家123' });
    expect(ok.status).toBe(200);
    // 复位后再失败 → 仍是正常 401（不是被限流 429）
    const again = await request(app)
      .post('/api/admin/auth/login')
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ username: 'merchant', password: 'wrong' });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('NOT_AUTH');
  });

  it('GET /api/admin/skus：SKU 行分页 total 正确 + keyword 匹配商品名/规格名（m9）', async () => {
    const m = await prisma.merchant.create({ data: { username: 'merchant', passwordHash: await hashPassword('x') } });
    const token = signMerchantToken(m.id);
    const auth = `Bearer ${token}`;

    const cat = await prisma.category.create({ data: { name: '主粮' } });
    const p1 = await prisma.product.create({ data: { categoryId: cat.id, name: '鸡肉狗粮', coverImage: 'http://img/x.png' } });
    const p2 = await prisma.product.create({ data: { categoryId: cat.id, name: '猫砂', coverImage: 'http://img/y.png', status: 'OFF' } });
    await prisma.sku.create({ data: { productId: p1.id, specName: '2kg', price: 9900, stock: 3 } });
    await prisma.sku.create({ data: { productId: p1.id, specName: '5kg', price: 19900, stock: 1 } });
    await prisma.sku.create({ data: { productId: p2.id, specName: '10L', price: 4500, stock: 0 } });

    const page = await request(createApp()).get('/api/admin/skus?page=1&size=2').set('Authorization', auth);
    expect(page.status).toBe(200);
    expect(page.body.data.total).toBe(3); // total=SKU 数而非商品数
    expect(page.body.data.list).toHaveLength(2);
    expect(page.body.data.list[0].productName).toBeTruthy();
    expect(page.body.data.list[0].skuId).toBeGreaterThan(0);

    const kw = await request(createApp()).get('/api/admin/skus?keyword=狗粮').set('Authorization', auth);
    expect(kw.body.data.total).toBe(2);

    const kw2 = await request(createApp()).get('/api/admin/skus?keyword=10L').set('Authorization', auth);
    expect(kw2.body.data.total).toBe(1);
    expect(kw2.body.data.list[0].specName).toBe('10L');

    const unauth = await request(createApp()).get('/api/admin/skus');
    expect(unauth.status).toBe(401);
  });
});

describe('生产环境门控（C2/I6）', () => {
  it('生产环境：/dev-login 不挂载（404），缺微信配置不启动', async () => {
    vi.resetModules();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 's'.repeat(32));
    vi.stubEnv('WX_APPID', 'wx-appid');
    vi.stubEnv('WX_APPSECRET', 'secret');
    const { createApp: prodCreateApp } = await import('./app');
    const app = prodCreateApp();
    const res = await request(app).post('/api/auth/dev-login').send({ code: 'c1' });
    expect(res.status).toBe(404);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('生产环境弱 JWT_SECRET（默认值）→ process.exit(1)（I6）', async () => {
    vi.resetModules();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'dev-secret-change-me');
    await import('./config/env');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('生产环境缺微信配置 → process.exit(1)（C2）', async () => {
    vi.resetModules();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 's'.repeat(32));
    vi.stubEnv('WX_APPID', '');
    vi.stubEnv('WX_APPSECRET', '');
    await import('./config/env');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('生产环境 mock openid 分支拒绝（authService 兜底）', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 's'.repeat(32));
    vi.stubEnv('WX_APPID', '');
    vi.stubEnv('WX_APPSECRET', '');
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loginWithCode } = await import('./services/authService');
    await expect(loginWithCode('code-anything', undefined)).rejects.toMatchObject({ status: 401 });
  });
});