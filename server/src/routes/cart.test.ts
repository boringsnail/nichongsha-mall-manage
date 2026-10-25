import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';

let skuId = 0;

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

  const cat = await prisma.category.create({ data: { name: '主粮' } });
  const p = await prisma.product.create({
    data: { categoryId: cat.id, name: '鸡肉猫粮', coverImage: 'http://img/a.png', status: 'ON' },
  });
  const sku = await prisma.sku.create({ data: { productId: p.id, specName: '2kg', price: 19900, stock: 1000 } });
  skuId = sku.id;
});

async function login(code: string) {
  const res = await request(createApp()).post('/api/auth/dev-login').send({ code });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

describe('购物车 API', () => {
  it('未登录 → 401', async () => {
    const res = await request(createApp()).get('/api/cart');
    expect(res.status).toBe(401);
  });

  it('初始为空数组，勾选总和为 0', async () => {
    const token = await login('c12-a');
    const res = await request(createApp()).get('/api/cart').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.list).toEqual([]);
    expect(res.body.data.checkedAmount).toBe(0);
    expect(res.body.data.checkedCount).toBe(0);
  });

  it('加入商品：条目含商品信息与勾选状态', async () => {
    const token = await login('c12-b');
    const res = await request(createApp())
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ skuId, quantity: 2 });
    expect(res.status).toBe(200);
    const item = res.body.data.list[0];
    expect(item.skuId).toBe(skuId);
    expect(item.name).toBe('鸡肉猫粮');
    expect(item.specName).toBe('2kg');
    expect(item.price).toBe(19900);
    expect(item.stock).toBe(1000);
    expect(item.quantity).toBe(2);
    expect(item.checked).toBe(true);
    expect(res.body.data.checkedAmount).toBe(39800);
    expect(res.body.data.checkedCount).toBe(1);
  });

  it('重复加入同一 SKU → 累加数量不新增行', async () => {
    const token = await login('c12-c');
    const app = createApp();
    await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: 2 });
    const res = await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: 3 });
    expect(res.body.data.list).toHaveLength(1);
    expect(res.body.data.list[0].quantity).toBe(5);
  });

  it('累加超过上限 999 → 400 PARAM_ERROR', async () => {
    const token = await login('c12-d');
    const app = createApp();
    await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: 998 });
    const res = await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: 2 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PARAM_ERROR');
  });

  it('不存在的 SKU → 404', async () => {
    const token = await login('c12-e');
    const res = await request(createApp())
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ skuId: 999999, quantity: 1 });
    expect(res.status).toBe(404);
  });

  it('数量 ≤0 或 >999 → 400', async () => {
    const token = await login('c12-f');
    const app = createApp();
    for (const q of [0, -1, 1000]) {
      const res = await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: q });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PARAM_ERROR');
    }
  });

  it('PUT 修改数量与勾选', async () => {
    const token = await login('c12-g');
    const app = createApp();
    await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: 3 });
    const put = await request(app)
      .put(`/api/cart/${skuId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity: 1, checked: false });
    expect(put.status).toBe(200);
    expect(put.body.data.list[0].quantity).toBe(1);
    expect(put.body.data.list[0].checked).toBe(false);
    expect(put.body.data.checkedAmount).toBe(0);
  });

  it('PUT 不存在条目 → 404', async () => {
    const token = await login('c12-h');
    const res = await request(createApp())
      .put(`/api/cart/${skuId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity: 1 });
    expect(res.status).toBe(404);
  });

  it('DELETE 移除条目', async () => {
    const token = await login('c12-i');
    const app = createApp();
    await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: 1 });
    const del = await request(app).delete(`/api/cart/${skuId}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    const res = await request(app).get('/api/cart').set('Authorization', `Bearer ${token}`);
    expect(res.body.data.list).toEqual([]);
  });

  it('batch/checked 全选/取消全选', async () => {
    const token = await login('c12-j');
    const app = createApp();
    const p2 = await prisma.product.create({
      data: { categoryId: (await prisma.product.findFirst({ where: { name: '鸡肉猫粮' } }))!.categoryId, name: '逗猫棒', coverImage: 'http://img/b.png', status: 'ON' },
    });
    const sku2 = await prisma.sku.create({ data: { productId: p2.id, specName: '单支', price: 1500, stock: 9 } });
    await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId, quantity: 2 });
    await request(app).post('/api/cart').set('Authorization', `Bearer ${token}`).send({ skuId: sku2.id, quantity: 1 });

    const uncheck = await request(app)
      .put('/api/cart/batch/checked')
      .set('Authorization', `Bearer ${token}`)
      .send({ checked: false });
    expect(uncheck.status).toBe(200);
    expect(uncheck.body.data.checkedAmount).toBe(0);

    const recheck = await request(app)
      .put('/api/cart/batch/checked')
      .set('Authorization', `Bearer ${token}`)
      .send({ checked: true });
    expect(recheck.body.data.checkedAmount).toBe(39800 + 1500);
    expect(recheck.body.data.checkedCount).toBe(2);
  });
});
