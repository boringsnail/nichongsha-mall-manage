import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';

let merchantToken: string;
let skuId = 0;

async function makeUser(code: string) {
  const login = await request(createApp()).post('/api/auth/dev-login').send({ code });
  const token = login.body.data.token as string;
  const addr = await request(createApp())
    .post('/api/user/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({ receiverName: '张三', phone: '13800138000', province: '广东省', city: '深圳市', district: '南山区', detail: '科技园路 1 号' });
  return { token, addrId: addr.body.data.id as number };
}

async function createOrder(token: string, addrId: number) {
  const res = await request(createApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ skuId, quantity: 1 }], addressId: addrId });
  return res.body.data.orderNo as string;
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
  await prisma.user.deleteMany();

  const m = await prisma.merchant.create({ data: { username: 'merchant', passwordHash: await hashPassword('x') } });
  merchantToken = signMerchantToken(m.id);
  const cat = await prisma.category.create({ data: { name: '主粮' } });
  const p = await prisma.product.create({
    data: { categoryId: cat.id, name: '鸡肉猫粮', coverImage: 'http://img/a.png', status: 'ON' },
  });
  skuId = (await prisma.sku.create({ data: { productId: p.id, specName: '2kg', price: 19900, stock: 10 } })).id;
});

function merchantAuth() {
  return `Bearer ${merchantToken}`;
}

describe('商家订单管理 API', () => {
  it('未带 token → 401', async () => {
    const res = await request(createApp()).get('/api/admin/orders');
    expect(res.status).toBe(401);
  });

  it('列表初始为空（分页结构）', async () => {
    const res = await request(createApp()).get('/api/admin/orders').set('Authorization', merchantAuth());
    expect(res.status).toBe(200);
    expect(res.body.data.list).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('列表可见用户订单（含用户信息与条目数），支持 status 过滤', async () => {
    const { token, addrId } = await makeUser('a14-1');
    const orderNo = await createOrder(token, addrId);
    const { token: t2, addrId: a2 } = await makeUser('a14-2');
    const orderNo2 = await createOrder(t2, a2);
    await request(createApp()).post(`/api/orders/${orderNo2}/pay`).set('Authorization', `Bearer ${t2}`);

    const app = createApp();
    const all = await request(app).get('/api/admin/orders').set('Authorization', merchantAuth());
    expect(all.body.data.total).toBe(2);
    const row = all.body.data.list.find((o: any) => o.orderNo === orderNo);
    expect(row.user.nickname).toBeNull();
    expect(row.user.openid).toBe('dev-a14-1');
    expect(row.totalAmount).toBe(19900);
    expect(row.status).toBe('PENDING_PAYMENT');
    expect(row.itemCount).toBe(1);

    const paid = await request(app).get('/api/admin/orders?status=PAID').set('Authorization', merchantAuth());
    expect(paid.body.data.total).toBe(1);
    expect(paid.body.data.list[0].orderNo).toBe(orderNo2);
  });

  it('ship：PAID → SHIPPED，记录 shippedAt 与物流信息', async () => {
    const { token, addrId } = await makeUser('a14-3');
    const orderNo = await createOrder(token, addrId);
    await request(createApp()).post(`/api/orders/${orderNo}/pay`).set('Authorization', `Bearer ${token}`);

    const res = await request(createApp())
      .post(`/api/admin/orders/${orderNo}/ship`)
      .set('Authorization', merchantAuth())
      .send({ logisticsCompany: '顺丰速运', trackingNo: 'SF123456789' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SHIPPED');
    expect(res.body.data.shippedAt).toBeTruthy();
    expect(res.body.data.logisticsCompany).toBe('顺丰速运');
    expect(res.body.data.trackingNo).toBe('SF123456789');

    // 状态确已落库
    const order = await prisma.order.findUnique({ where: { orderNo } });
    expect(order!.status).toBe('SHIPPED');
  });

  it('ship 非 PAID（待支付）→ 409 ORDER_STATUS_ILLEGAL', async () => {
    const { token, addrId } = await makeUser('a14-4');
    const orderNo = await createOrder(token, addrId);
    const res = await request(createApp())
      .post(`/api/admin/orders/${orderNo}/ship`)
      .set('Authorization', merchantAuth())
      .send({ logisticsCompany: '顺丰速运', trackingNo: 'SF1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_STATUS_ILLEGAL');
  });

  it('ship 已发货订单 → 409（重复发货）', async () => {
    const { token, addrId } = await makeUser('a14-5');
    const orderNo = await createOrder(token, addrId);
    await request(createApp()).post(`/api/orders/${orderNo}/pay`).set('Authorization', `Bearer ${token}`);
    const app = createApp();
    await request(app).post(`/api/admin/orders/${orderNo}/ship`).set('Authorization', merchantAuth()).send({ logisticsCompany: '顺丰', trackingNo: 'SF1' });
    const res = await request(app).post(`/api/admin/orders/${orderNo}/ship`).set('Authorization', merchantAuth()).send({ logisticsCompany: '顺丰', trackingNo: 'SF2' });
    expect(res.status).toBe(409);
  });

  it('ship 不存在订单 → 404', async () => {
    const res = await request(createApp())
      .post('/api/admin/orders/NPA0000000000000000/ship')
      .set('Authorization', merchantAuth())
      .send({ logisticsCompany: '顺丰速运', trackingNo: 'SF1' });
    expect(res.status).toBe(404);
  });

  it('ship 缺物流字段 → 400', async () => {
    const { token, addrId } = await makeUser('a14-6');
    const orderNo = await createOrder(token, addrId);
    await request(createApp()).post(`/api/orders/${orderNo}/pay`).set('Authorization', `Bearer ${token}`);
    const res = await request(createApp())
      .post(`/api/admin/orders/${orderNo}/ship`)
      .set('Authorization', merchantAuth())
      .send({ logisticsCompany: '顺丰速运' });
    expect(res.status).toBe(400);
  });

  it('详情：返回用户/地址快照/商品明细/物流信息', async () => {
    const { token, addrId } = await makeUser('a14-7');
    const orderNo = await createOrder(token, addrId);
    await request(createApp()).post(`/api/orders/${orderNo}/pay`).set('Authorization', `Bearer ${token}`);
    await request(createApp())
      .post(`/api/admin/orders/${orderNo}/ship`)
      .set('Authorization', merchantAuth())
      .send({ logisticsCompany: '顺丰速运', trackingNo: 'SF888' });

    const res = await request(createApp()).get(`/api/admin/orders/${orderNo}`).set('Authorization', merchantAuth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.user.openid).toBe('dev-a14-7');
    expect(d.address.receiverName).toBe('张三');
    expect(d.items).toHaveLength(1);
    expect(d.items[0].productName).toBe('鸡肉猫粮');
    expect(d.logisticsCompany).toBe('顺丰速运');
    expect(d.trackingNo).toBe('SF888');
  });
});
