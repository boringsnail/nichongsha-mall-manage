import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';

let merchantToken: string;
let paidProductId = 0;
let lowStockSkuId = 0;
let normalStockSkuId = 0;

async function makeUser(code: string) {
  const login = await request(createApp()).post('/api/auth/dev-login').send({ code });
  const token = login.body.data.token as string;
  const addr = await request(createApp())
    .post('/api/user/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({ receiverName: '张三', phone: '13800138000', province: '广东省', city: '深圳市', district: '南山区', detail: '科技园路 1 号' });
  return { token, addrId: addr.body.data.id as number };
}

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
  await prisma.merchant.deleteMany();
  await prisma.userEvent.deleteMany();
  await prisma.user.deleteMany();

  const m = await prisma.merchant.create({ data: { username: 'merchant', passwordHash: await hashPassword('x') } });
  merchantToken = signMerchantToken(m.id);

  const cat = await prisma.category.create({ data: { name: '主粮' } });
  const p1 = await prisma.product.create({
    data: { categoryId: cat.id, name: '鸡肉猫粮', coverImage: 'http://img/a.png', status: 'ON' },
  });
  const p2 = await prisma.product.create({
    data: { categoryId: cat.id, name: '自动饮水机', coverImage: 'http://img/b.png', status: 'ON' },
  });
  paidProductId = p1.id;
  // 种子库存 8：两笔下单共扣 3（2+1），剩余 5（≤10 仍属低库存），断言保持 5
  lowStockSkuId = (await prisma.sku.create({ data: { productId: p1.id, specName: '2kg', price: 19900, stock: 8 } })).id;
  normalStockSkuId = (await prisma.sku.create({ data: { productId: p2.id, specName: '2L', price: 12900, stock: 50 } })).id;

  // 用户 A：1 单已支付 qty=2；用户 B：1 单待支付 qty=1
  const a = await makeUser('s15-a');
  const oa = await request(createApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${a.token}`)
    .send({ items: [{ skuId: lowStockSkuId, quantity: 2 }], addressId: a.addrId });
  await request(createApp()).post(`/api/orders/${oa.body.data.orderNo}/pay`).set('Authorization', `Bearer ${a.token}`);

  const b = await makeUser('s15-b');
  await request(createApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${b.token}`)
    .send({ items: [{ skuId: lowStockSkuId, quantity: 1 }], addressId: b.addrId });
});

function auth() {
  return `Bearer ${merchantToken}`;
}

describe('营业大盘统计 API', () => {
  it('overview：GMV 只含已支付，toShip=已付未发，lowStock 计数', async () => {
    const res = await request(createApp()).get('/api/admin/stats/overview').set('Authorization', auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.today.orderCount).toBe(2); // 今日创建 2 单
    expect(d.today.gmv).toBe(19900 * 2); // 仅已支付那单
    expect(d.today.salesCount).toBe(2); // 已支付那单的商品件数
    expect(d.toShip).toBe(1); // PAID 未发货
    expect(d.lowStockCount).toBe(1); // 库存 5 ≤ 默认阈值 10
    expect(d.week.gmv).toBe(19900 * 2);
  });

  it('overview 未带 token → 401', async () => {
    const res = await request(createApp()).get('/api/admin/stats/overview');
    expect(res.status).toBe(401);
  });

  it('top-products：按销量数量排，含 GMV', async () => {
    const res = await request(createApp()).get('/api/admin/stats/top-products?days=7&limit=10').set('Authorization', auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toHaveLength(1);
    expect(d[0].productId).toBe(paidProductId);
    expect(d[0].name).toBe('鸡肉猫粮');
    expect(d[0].salesCount).toBe(2);
    expect(d[0].gmv).toBe(19900 * 2);
  });

  it('low-stock：阈值过滤（5 ≤ 10；50 > 10）', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/stats/low-stock?threshold=10').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].skuId).toBe(lowStockSkuId);
    expect(res.body.data[0].productName).toBe('鸡肉猫粮');
    expect(res.body.data[0].stock).toBe(5);

    const wide = await request(app).get('/api/admin/stats/low-stock?threshold=50').set('Authorization', auth());
    expect(wide.body.data).toHaveLength(2);
    const skuIds = wide.body.data.map((x: any) => x.skuId).sort();
    expect(skuIds).toEqual([lowStockSkuId, normalStockSkuId].sort((a, b) => a - b));
  });

  it('low-stock 非法阈值 → 400', async () => {
    const res = await request(createApp()).get('/api/admin/stats/low-stock?threshold=-1').set('Authorization', auth());
    expect(res.status).toBe(400);
  });
});

describe('经营趋势 / 转化漏斗 / 经营建议', () => {
  async function seedEvents() {
    // 补 5 级漏斗：3 会话进入 → 3 浏览 → 2 加购 → 2 下单 → 1 支付
    const ev = (eventType: string, sessionId: string, extra: object = {}) =>
      prisma.userEvent.create({ data: { eventType, sessionId, ...extra } });

    for (const s of ['s1', 's2', 's3']) await ev('app_launch', s);
    for (const s of ['s1', 's2', 's3']) await ev('product_view', s, { productId: paidProductId });
    for (const s of ['s1', 's2']) await ev('add_cart', s, { productId: paidProductId, skuId: lowStockSkuId });
    for (const s of ['s1', 's2']) await ev('create_order', s);
    await ev('pay_success', 's1', { amount: 19900 });
  }

  it('trend：返回 N 天且缺失日期补 0，今日含已支付 GMV', async () => {
    const res = await request(createApp()).get('/api/admin/stats/trend?days=7').set('Authorization', auth());
    expect(res.status).toBe(200);
    const d = res.body.data as { date: string; gmv: number; orderCount: number; salesCount: number }[];
    expect(d).toHaveLength(7);
    // 日期升序
    expect(d[0].date < d[6].date).toBe(true);
    const today = d[d.length - 1];
    expect(today.gmv).toBe(19900 * 2);
    expect(today.orderCount).toBe(1);
    expect(today.salesCount).toBe(2);
    // 前面几天无支付 → 补 0
    expect(d[0].gmv).toBe(0);
  });

  it('trend：days 超范围 → 400', async () => {
    const res = await request(createApp()).get('/api/admin/stats/trend?days=999').set('Authorization', auth());
    expect(res.status).toBe(400);
  });

  it('trend 未授权 → 401', async () => {
    const res = await request(createApp()).get('/api/admin/stats/trend');
    expect(res.status).toBe(401);
  });

  it('funnel：按会话去重，逐级递减并算出转化率与最大流失', async () => {
    await seedEvents();
    const res = await request(createApp()).get('/api/admin/stats/funnel?days=30').set('Authorization', auth());
    expect(res.status).toBe(200);
    const { stages, worst } = res.body.data as {
      stages: { stage: string; label: string; value: number; count: number; ratio: number; rate: number }[];
      worst: { from: string; to: string; dropRate: number } | null;
    };

    expect(stages).toHaveLength(5);
    expect(stages.map((s) => s.stage)).toEqual([
      'app_launch',
      'product_view',
      'add_cart',
      'create_order',
      'pay_success',
    ]);
    // 去重会话数逐级递减
    expect(stages.map((s) => s.value)).toEqual([3, 3, 2, 2, 1]);
    // 原始事件次数（首级应等于真实上报数，防止 stage 键写错导致恒 0）
    expect(stages[0].count).toBe(3);
    expect(stages[0].rate).toBe(100);
    expect(stages[4].rate).toBe(33.3);
    // 最大流失：加购 → 下单（2→... 实际支付 2→1 是 50%，加购→下单也是 50%，取首个最大）
    expect(worst).not.toBeNull();
    expect(worst!.dropRate).toBeGreaterThan(0);
  });

  it('funnel：无埋点数据时返回全 0 且不报错', async () => {
    const res = await request(createApp()).get('/api/admin/stats/funnel?days=30').set('Authorization', auth());
    expect(res.status).toBe(200);
    const { stages } = res.body.data as { stages: { value: number }[] };
    expect(stages.every((s) => s.value === 0)).toBe(true);
  });

  it('advice：低库存与滞销能触发对应建议', async () => {
    const res = await request(createApp()).get('/api/admin/stats/advice?days=30').set('Authorization', auth());
    expect(res.status).toBe(200);
    const list = res.body.data as { level: string; title: string; detail: string }[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    const titles = list.map((a) => a.title).join(' | ');
    expect(titles).toContain('库存偏低'); // lowStockSkuId 剩 5 ≤ 10
    expect(titles).toContain('零销量'); // 自动饮水机 90 天无成交
    // 每条建议结构完整
    for (const a of list) {
      expect(['info', 'warn', 'danger']).toContain(a.level);
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.detail.length).toBeGreaterThan(0);
    }
  });

  it('advice：支付转化偏低时会给出警示', async () => {
    await seedEvents(); // 下单 2 会话、支付 1 会话 → 50%
    const res = await request(createApp()).get('/api/admin/stats/advice?days=30').set('Authorization', auth());
    const list = res.body.data as { level: string; title: string; detail: string }[];
    const pay = list.find((a) => a.title.includes('支付转化'));
    expect(pay).toBeDefined();
    expect(['warn', 'danger']).toContain(pay!.level);
    expect(pay!.detail).toContain('50.0%');
  });
});
