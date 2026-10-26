import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';

/**
 * 「用户访问」：商品浏览 / 登录 / 购物车。
 *
 * 三个数据源口径不同，断言刻意分开：
 *   - 浏览：只认 product_view，add_cart 不能混进 PV
 *   - 登录：次数 / 人数 / 新客 是三个独立指标
 *   - 购物车：是快照不是流水，金额按 sku.price × quantity 现算
 */

let merchantToken: string;
let userAId = 0;
let userBId = 0;
let productAId = 0;
let productBId = 0;
let skuAId = 0;
let skuBId = 0;

function api() {
  return request(createApp());
}

async function makeUser(code: string) {
  const res = await api().post('/api/auth/dev-login').send({ code });
  return { token: res.body.data.token as string, userId: res.body.data.user.id as number };
}

beforeEach(async () => {
  await prisma.loginLog.deleteMany();
  await prisma.searchLog.deleteMany();
  await prisma.userEvent.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.address.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.afterSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.merchant.deleteMany();
  await prisma.user.deleteMany();

  const m = await prisma.merchant.create({ data: { username: 'merchant', passwordHash: await hashPassword('x') } });
  merchantToken = signMerchantToken(m.id);

  const cat = await prisma.category.create({ data: { name: '主粮' } });
  const pa = await prisma.product.create({
    data: { categoryId: cat.id, name: '鸡肉猫粮', coverImage: 'http://img/a.png', status: 'ON', minPrice: 9900 },
  });
  const pb = await prisma.product.create({
    data: { categoryId: cat.id, name: '自动饮水机', coverImage: 'http://img/b.png', status: 'ON', minPrice: 12900 },
  });
  productAId = pa.id;
  productBId = pb.id;
  const sa = await prisma.sku.create({ data: { productId: pa.id, specName: '2kg', price: 9900, stock: 50 } });
  const sb = await prisma.sku.create({ data: { productId: pb.id, specName: '2L', price: 12900, stock: 50 } });
  skuAId = sa.id;
  skuBId = sb.id;

  const a = await makeUser('visit-a');
  const b = await makeUser('visit-b');
  userAId = a.userId;
  userBId = b.userId;
  // 上面两次登录会各写一条登录记录，这里清掉，让每个用例自己造数
  await prisma.loginLog.deleteMany();
});

describe('GET /api/admin/visits/overview', () => {
  it('浏览只统计 product_view，加购事件不混进 PV', async () => {
    await prisma.userEvent.createMany({
      data: [
        { eventType: 'product_view', userId: userAId, openid: 'o-a', sessionId: 's-a', productId: productAId },
        { eventType: 'product_view', userId: userAId, openid: 'o-a', sessionId: 's-a', productId: productBId },
        { eventType: 'product_view', sessionId: 's-guest', productId: productAId },
        { eventType: 'add_cart', userId: userAId, openid: 'o-a', sessionId: 's-a', skuId: skuAId },
      ],
    });

    const res = await api()
      .get('/api/admin/visits/overview?days=30')
      .set('Authorization', `Bearer ${merchantToken}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.views.pv).toBe(3);
    // userA 一条 + 游客 session 一条
    expect(d.views.uv).toBe(2);
    expect(d.views.productCount).toBe(2);
    expect(d.views.guestViews).toBe(1);
    expect(d.views.guestRate).toBe(33.3);
  });

  it('登录统计：次数 / 人数 / 新客分开算', async () => {
    await prisma.loginLog.createMany({
      data: [
        { userId: userAId, openid: 'o-a', via: 'cloud', isNewUser: true },
        { userId: userAId, openid: 'o-a', via: 'cloud', isNewUser: false },
        { userId: userBId, openid: 'o-b', via: 'code', isNewUser: false },
      ],
    });

    const d = (
      await api().get('/api/admin/visits/overview').set('Authorization', `Bearer ${merchantToken}`)
    ).body.data;
    expect(d.logins.count).toBe(3);
    expect(d.logins.users).toBe(2);
    expect(d.logins.newUsers).toBe(1);
  });

  it('购物车：金额按 sku.price×quantity 现算，超 24 小时算待催单', async () => {
    const old = new Date(Date.now() - 30 * 3600 * 1000);
    await prisma.cart.create({
      data: { userId: userAId, skuId: skuAId, quantity: 2, createdAt: old },
    });
    await prisma.cart.create({ data: { userId: userBId, skuId: skuBId, quantity: 1 } });

    const d = (
      await api().get('/api/admin/visits/overview').set('Authorization', `Bearer ${merchantToken}`)
    ).body.data;
    expect(d.cart.items).toBe(2);
    expect(d.cart.users).toBe(2);
    expect(d.cart.amount).toBe(9900 * 2 + 12900);
    expect(d.cart.stale).toBe(1);
  });

  it('时间窗外的事件不计入', async () => {
    const longAgo = new Date(Date.now() - 40 * 86400000);
    await prisma.userEvent.create({
      data: { eventType: 'product_view', userId: userAId, productId: productAId, createdAt: longAgo },
    });
    await prisma.loginLog.create({
      data: { userId: userAId, openid: 'o-a', createdAt: longAgo },
    });

    const d = (
      await api().get('/api/admin/visits/overview?days=30').set('Authorization', `Bearer ${merchantToken}`)
    ).body.data;
    expect(d.views.pv).toBe(0);
    expect(d.logins.count).toBe(0);
  });

  it('空数据不报错，除零不出现 NaN', async () => {
    const d = (
      await api().get('/api/admin/visits/overview').set('Authorization', `Bearer ${merchantToken}`)
    ).body.data;
    expect(d.views).toMatchObject({ pv: 0, uv: 0, productCount: 0, guestRate: 0 });
    expect(d.cart.amount).toBe(0);
  });
});

describe('GET /api/admin/visits/views', () => {
  it('返回商品信息与用户信息，游客的 user 为 null', async () => {
    await prisma.userEvent.create({
      data: { eventType: 'product_view', userId: userAId, openid: 'o-a', productId: productAId, skuId: skuAId },
    });
    await prisma.userEvent.create({
      data: { eventType: 'product_view', sessionId: 's-guest', productId: productBId },
    });

    const res = await api()
      .get('/api/admin/visits/views?days=30')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);

    const guest = res.body.data.list.find((r: { user: unknown }) => r.user === null);
    expect(guest).toBeTruthy();
    expect(guest.product.name).toBe('自动饮水机');
    expect(guest.sessionId).toBe('s-guest');

    const mine = res.body.data.list.find((r: { user: { id: number } | null }) => r.user?.id === userAId);
    expect(mine.product.name).toBe('鸡肉猫粮');
    expect(mine.product.coverImage).toBe('http://img/a.png');
    expect(mine.skuId).toBe(skuAId);
  });

  it('按 userId 下钻只看这个人的浏览', async () => {
    await prisma.userEvent.create({
      data: { eventType: 'product_view', userId: userAId, productId: productAId },
    });
    await prisma.userEvent.create({
      data: { eventType: 'product_view', userId: userBId, productId: productBId },
    });

    const res = await api()
      .get(`/api/admin/visits/views?userId=${userBId}`)
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0].product.name).toBe('自动饮水机');
  });

  it('商品被删掉时给出兜底文案而不是 null 崩页面', async () => {
    await prisma.userEvent.create({
      data: { eventType: 'product_view', userId: userAId, productId: 999999 },
    });
    const res = await api()
      .get('/api/admin/visits/views')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.body.data.list[0].product.name).toBe('商品已删除');
  });

  it('分页参数生效', async () => {
    await prisma.userEvent.createMany({
      data: Array.from({ length: 5 }, () => ({
        eventType: 'product_view',
        userId: userAId,
        productId: productAId,
      })),
    });
    const res = await api()
      .get('/api/admin/visits/views?page=2&size=2')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.body.data.total).toBe(5);
    expect(res.body.data.list).toHaveLength(2);
    expect(res.body.data.page).toBe(2);
  });
});

describe('GET /api/admin/visits/logins', () => {
  it('返回登录方式、IP、设备与是否新客', async () => {
    await prisma.loginLog.create({
      data: {
        userId: userAId,
        openid: 'o-a',
        via: 'cloud',
        ip: '1.2.3.4',
        userAgent: 'MicroMessenger/8.0',
        isNewUser: true,
      },
    });

    const res = await api()
      .get('/api/admin/visits/logins')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.list[0];
    expect(row.via).toBe('cloud');
    expect(row.ip).toBe('1.2.3.4');
    expect(row.userAgent).toBe('MicroMessenger/8.0');
    expect(row.isNewUser).toBe(true);
    expect(row.user.id).toBe(userAId);
  });

  it('按 userId 过滤', async () => {
    await prisma.loginLog.createMany({
      data: [
        { userId: userAId, openid: 'o-a' },
        { userId: userBId, openid: 'o-b' },
        { userId: userBId, openid: 'o-b' },
      ],
    });
    const res = await api()
      .get(`/api/admin/visits/logins?userId=${userBId}`)
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.body.data.total).toBe(2);
  });
});

describe('GET /api/admin/visits/carts', () => {
  it('返回规格、单价、小计与用户', async () => {
    await prisma.cart.create({ data: { userId: userAId, skuId: skuAId, quantity: 3 } });

    const res = await api()
      .get('/api/admin/visits/carts')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.totalQuantity).toBe(3);
    const row = res.body.data.list[0];
    expect(row.specName).toBe('2kg');
    expect(row.price).toBe(9900);
    expect(row.subtotal).toBe(29700);
    expect(row.product.name).toBe('鸡肉猫粮');
    expect(row.user.id).toBe(userAId);
  });

  it('按 userId 过滤', async () => {
    await prisma.cart.create({ data: { userId: userAId, skuId: skuAId } });
    await prisma.cart.create({ data: { userId: userBId, skuId: skuBId } });

    const res = await api()
      .get(`/api/admin/visits/carts?userId=${userBId}`)
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0].product.name).toBe('自动饮水机');
  });
});

describe('鉴权与参数校验', () => {
  it('没有令牌一律 401', async () => {
    for (const path of ['/api/admin/visits/overview', '/api/admin/visits/views', '/api/admin/visits/logins', '/api/admin/visits/carts']) {
      expect((await api().get(path)).status).toBe(401);
    }
  });

  it('days 越界与 size 超限被 400 拒绝', async () => {
    const a = await api()
      .get('/api/admin/visits/views?days=0')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(a.status).toBe(400);
    const b = await api()
      .get('/api/admin/visits/views?size=101')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(b.status).toBe(400);
    const c = await api()
      .get('/api/admin/visits/logins?days=400')
      .set('Authorization', `Bearer ${merchantToken}`);
    expect(c.status).toBe(400);
  });
});

describe('登录留痕', () => {
  it('每次登录写一条，首次登录标记为新客', async () => {
    // beforeEach 里已经用 dev-login 登录过两次，这里直接查历史
    const first = await prisma.loginLog.count();
    expect(first).toBe(0); // 已被 beforeEach 清空

    const res = await api().post('/api/auth/dev-login').send({ code: 'visit-new' });
    expect(res.status).toBe(200);
    const userId = res.body.data.user.id as number;

    const logs = await prisma.loginLog.findMany({ where: { userId }, orderBy: { id: 'asc' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].isNewUser).toBe(true);
    expect(logs[0].via).toBe('dev');
    expect(logs[0].source).toBe('miniprogram');
    expect(logs[0].openid).toBe('dev-visit-new');

    // 同一设备再登一次：不算新客
    await api().post('/api/auth/dev-login').send({ code: 'visit-new' });
    const again = await prisma.loginLog.findMany({ where: { userId }, orderBy: { id: 'asc' } });
    expect(again).toHaveLength(2);
    expect(again[1].isNewUser).toBe(false);
  });

  it('记录 IP 与 User-Agent', async () => {
    const res = await api()
      .post('/api/auth/dev-login')
      .set('X-Forwarded-For', '9.9.9.9, 10.0.0.1')
      .set('User-Agent', 'MicroMessenger/8.0.5')
      .send({ code: 'visit-ua' });
    const userId = res.body.data.user.id as number;
    const log = await prisma.loginLog.findFirst({ where: { userId } });
    expect(log?.ip).toBe('9.9.9.9');
    expect(log?.userAgent).toBe('MicroMessenger/8.0.5');
  });
});
