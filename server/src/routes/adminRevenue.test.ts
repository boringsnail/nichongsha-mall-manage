import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';

/**
 * 营收口径（配送成本 / 净营业额）、商品 TOP N 与单品趋势、搜索分析。
 *
 * 造数刻意让「总额 / 退款 / 配送成本」三个数互不相同，
 * 这样任何一项算错都能被断言抓出来（相等的话乘除颠倒也能过）。
 */

let merchantToken: string;
let paidOrderNo = '';
let secondOrderNo = '';
let cancelledOrderNo = '';
let p1 = 0;
let p2 = 0;
let userAId = 0;
let userBId = 0;

async function makeUser(code: string) {
  const login = await request(createApp()).post('/api/auth/dev-login').send({ code });
  const token = login.body.data.token as string;
  const addr = await request(createApp())
    .post('/api/user/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({ receiverName: '张三', phone: '13800138000', province: '广东省', city: '深圳市', district: '南山区', detail: '科技园路 1 号' });
  return { token, addrId: addr.body.data.id as number, userId: login.body.data.user.id as number };
}

beforeEach(async () => {
  await prisma.address.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.afterSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.searchLog.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.merchant.deleteMany();
  await prisma.userEvent.deleteMany();
  await prisma.user.deleteMany();

  const m = await prisma.merchant.create({ data: { username: 'merchant', passwordHash: await hashPassword('x') } });
  merchantToken = signMerchantToken(m.id);

  const cat = await prisma.category.create({ data: { name: '主粮' } });
  const prod1 = await prisma.product.create({
    data: { categoryId: cat.id, name: '鸡肉猫粮', coverImage: 'http://img/a.png', status: 'ON' },
  });
  const prod2 = await prisma.product.create({
    data: { categoryId: cat.id, name: '自动饮水机', coverImage: 'http://img/b.png', status: 'ON' },
  });
  p1 = prod1.id;
  p2 = prod2.id;
  const sku1 = await prisma.sku.create({ data: { productId: p1, specName: '2kg', price: 19900, stock: 50 } });
  const sku2 = await prisma.sku.create({ data: { productId: p2, specName: '2L', price: 12900, stock: 50 } });

  const a = await makeUser('rev-a');
  const b = await makeUser('rev-b');
  userAId = a.userId;
  userBId = b.userId;

  const mk = async (token: string, addrId: number, skuId: number, quantity: number) =>
    (
      await request(createApp())
        .post('/api/orders')
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ skuId, quantity }], addressId: addrId })
    ).body.data.orderNo as string;

  paidOrderNo = await mk(a.token, a.addrId, sku1.id, 2);
  await request(createApp()).post(`/api/orders/${paidOrderNo}/pay`).set('Authorization', `Bearer ${a.token}`);

  secondOrderNo = await mk(b.token, b.addrId, sku2.id, 1);
  await request(createApp()).post(`/api/orders/${secondOrderNo}/pay`).set('Authorization', `Bearer ${b.token}`);

  cancelledOrderNo = await mk(b.token, b.addrId, sku2.id, 1);
  await prisma.order.update({ where: { orderNo: cancelledOrderNo }, data: { status: 'CANCELLED', cancelledAt: new Date() } });

  // 让三个数各不相同：gross = 39800 + 12900 = 52700，refund = 5000，delivery = 800
  await prisma.order.update({ where: { orderNo: paidOrderNo }, data: { deliveryCost: 800, refundedAmount: 5000 } });
});

const auth = () => ({ Authorization: `Bearer ${merchantToken}` });

describe('营收口径：总营业额 / 退款 / 配送成本 / 净营业额', () => {
  it('净营业额 = 总营业额 − 退款 − 配送成本，且只统计已支付订单', async () => {
    const res = await request(createApp()).get('/api/admin/stats/revenue?days=30').set(auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.gross).toBe(52700); // 已取消那单不算
    expect(d.refund).toBe(5000);
    expect(d.deliveryCost).toBe(800);
    expect(d.net).toBe(52700 - 5000 - 800);
    expect(d.orderCount).toBe(2);
    expect(d.aov).toBe(Math.round(52700 / 2));
    expect(d.netRate).toBe(Number((((52700 - 5800) / 52700) * 100).toFixed(1)));
    // 还有一单没录配送成本，商家补上净额才准
    expect(d.missingDeliveryCost).toBe(1);
  });

  it('趋势里的净额与营收接口同口径', async () => {
    const res = await request(createApp()).get('/api/admin/stats/trend?days=7').set(auth());
    const today = (res.body.data as { date: string; gmv: number; net: number; deliveryCost: number; refund: number }[]).at(-1)!;
    expect(today.gmv).toBe(52700);
    expect(today.refund).toBe(5000);
    expect(today.deliveryCost).toBe(800);
    expect(today.net).toBe(46900);
  });

  it('未登录不能看营收', async () => {
    expect((await request(createApp()).get('/api/admin/stats/revenue')).status).toBe(401);
  });
});

describe('订单录入配送成本', () => {
  it('能改，并返回改前的值', async () => {
    const res = await request(createApp())
      .put(`/api/admin/orders/${secondOrderNo}/delivery-cost`)
      .set(auth())
      .send({ deliveryCost: 1500 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderNo: secondOrderNo, deliveryCost: 1500, previous: 0 });

    const rev = await request(createApp()).get('/api/admin/stats/revenue?days=30').set(auth());
    expect(rev.body.data.deliveryCost).toBe(800 + 1500);
    expect(rev.body.data.missingDeliveryCost).toBe(0);
  });

  it('改配送成本不影响顾客实付金额', async () => {
    await request(createApp())
      .put(`/api/admin/orders/${secondOrderNo}/delivery-cost`)
      .set(auth())
      .send({ deliveryCost: 1500 });
    const detail = await request(createApp()).get(`/api/admin/orders/${secondOrderNo}`).set(auth());
    expect(detail.body.data.totalAmount).toBe(12900);
    expect(detail.body.data.deliveryCost).toBe(1500);
  });

  it('负数、超上限、已取消订单都被拒', async () => {
    const neg = await request(createApp())
      .put(`/api/admin/orders/${secondOrderNo}/delivery-cost`)
      .set(auth())
      .send({ deliveryCost: -1 });
    expect(neg.status).toBe(400);

    const huge = await request(createApp())
      .put(`/api/admin/orders/${secondOrderNo}/delivery-cost`)
      .set(auth())
      .send({ deliveryCost: 1_000_001 });
    expect(huge.status).toBe(400);

    // 已取消的订单没有履约成本：状态冲突用 409（不是参数错，是当前状态不允许）
    const cancelled = await request(createApp())
      .put(`/api/admin/orders/${cancelledOrderNo}/delivery-cost`)
      .set(auth())
      .send({ deliveryCost: 500 });
    expect(cancelled.status).toBe(409);
  });

  it('列表里带上配送成本与已退金额，前端不用再查详情', async () => {
    const res = await request(createApp()).get('/api/admin/orders?page=1&size=10').set(auth());
    const row = (res.body.data.list as { orderNo: string; deliveryCost: number; refundedAmount: number }[]).find(
      (o) => o.orderNo === paidOrderNo
    )!;
    expect(row.deliveryCost).toBe(800);
    expect(row.refundedAmount).toBe(5000);
  });
});

describe('商品销量 TOP N 与单品趋势', () => {
  it('按销量排序并带排名', async () => {
    const res = await request(createApp()).get('/api/admin/stats/top-products?days=30&limit=10').set(auth());
    expect(res.status).toBe(200);
    const d = res.body.data as { rank: number; productId: number; salesCount: number; gmv: number }[];
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ rank: 1, productId: p1, salesCount: 2, gmv: 39800 });
    expect(d[1]).toMatchObject({ rank: 2, productId: p2, salesCount: 1, gmv: 12900 });
  });

  it('limit 生效；1 年窗口与 30 天窗口都能查', async () => {
    const one = await request(createApp()).get('/api/admin/stats/top-products?days=365&limit=1').set(auth());
    expect(one.body.data).toHaveLength(1);

    const year = await request(createApp()).get('/api/admin/stats/top-products?days=365&limit=10').set(auth());
    expect(year.body.data).toHaveLength(2);
  });

  it('days 超过 365 或 limit 超过 50 被拒', async () => {
    expect((await request(createApp()).get('/api/admin/stats/top-products?days=366').set(auth())).status).toBe(400);
    expect((await request(createApp()).get('/api/admin/stats/top-products?limit=51').set(auth())).status).toBe(400);
  });

  it('单品趋势：补齐缺失日期，累计销量与 TOP 列表一致', async () => {
    const res = await request(createApp()).get(`/api/admin/stats/product-trend?productId=${p1}&days=30`).set(auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.name).toBe('鸡肉猫粮');
    expect(d.points).toHaveLength(30);
    expect(d.totalSales).toBe(2);
    expect(d.totalGmv).toBe(39800);
    // 今天有成交，历史日期补 0
    expect(d.points.at(-1).salesCount).toBe(2);
    expect(d.points[0].salesCount).toBe(0);
  });

  it('单品趋势：商品不存在 → 404', async () => {
    const res = await request(createApp()).get('/api/admin/stats/product-trend?productId=999999').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('搜索埋点与搜索分析', () => {
  async function track(keyword: string, resultCount: number, token?: string) {
    const r = request(createApp()).post('/api/track/search').send({ keyword, resultCount });
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r;
  }

  it('搜索埋点不需要登录也能上报', async () => {
    const res = await track('猫粮', 3);
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(true);
    expect(await prisma.searchLog.count()).toBe(1);
  });

  it('空关键词被拒（避免脏词污染热搜榜）', async () => {
    expect((await track('   ', 0)).status).toBe(400);
  });

  it('带 token 时把搜索记到人头上', async () => {
    const login = await request(createApp()).post('/api/auth/dev-login').send({ code: 'rev-a' });
    await track('猫砂', 2, login.body.data.token as string);
    const row = await prisma.searchLog.findFirstOrThrow();
    expect(row.userId).toBe(userAId);
  });

  it('总览：次数、无结果率、热搜词、无结果词、按用户聚合', async () => {
    const loginA = await request(createApp()).post('/api/auth/dev-login').send({ code: 'rev-a' });
    const tokenA = loginA.body.data.token as string;

    await track('猫粮', 3, tokenA);
    await track('猫粮', 3, tokenA);
    await track('冻干', 0, tokenA); // 搜了没结果
    await track('猫砂', 2); // 游客

    const res = await request(createApp()).get('/api/admin/stats/search?days=30').set(auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.total).toBe(4);
    expect(d.uniqueUsers).toBe(1); // 游客不计入人数
    expect(d.zeroResult).toBe(1);
    expect(d.zeroRate).toBe(25);
    expect(d.topKeywords[0]).toMatchObject({ keyword: '猫粮', count: 2, zeroCount: 0 });
    expect(d.zeroKeywords[0]).toMatchObject({ keyword: '冻干', zeroCount: 1 });
    expect(d.users[0]).toMatchObject({ userId: userAId, count: 3, lastKeyword: '冻干' });
    expect(d.trend).toHaveLength(30);
    expect(d.trend.at(-1).count).toBe(4);
  });

  it('明细可按用户过滤：点某个用户只看他的搜索记录', async () => {
    const loginA = await request(createApp()).post('/api/auth/dev-login').send({ code: 'rev-a' });
    const loginB = await request(createApp()).post('/api/auth/dev-login').send({ code: 'rev-b' });
    await track('猫粮', 3, loginA.body.data.token as string);
    await track('猫砂', 2, loginB.body.data.token as string);

    const res = await request(createApp())
      .get(`/api/admin/stats/search/logs?days=30&userId=${userBId}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0]).toMatchObject({ keyword: '猫砂', resultCount: 2 });
    expect(res.body.data.list[0].user.id).toBe(userBId);
  });

  it('明细可按关键词过滤', async () => {
    await track('猫粮', 3);
    await track('猫砂', 2);
    const res = await request(createApp()).get('/api/admin/stats/search/logs?keyword=猫砂').set(auth());
    expect(res.body.data.total).toBe(1);
  });

  it('搜索分析需要商家登录', async () => {
    expect((await request(createApp()).get('/api/admin/stats/search')).status).toBe(401);
    expect((await request(createApp()).get('/api/admin/stats/search/logs')).status).toBe(401);
  });
});
