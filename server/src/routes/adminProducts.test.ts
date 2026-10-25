import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';

let merchantToken: string;
let categoryId: number;

const app = () => createApp();

beforeEach(async () => {
  await prisma.orderItem.deleteMany();
  // 售后单引用 Order/User，必须先删，否则外键约束会挡住
  await prisma.afterSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.merchant.deleteMany();
  const m = await prisma.merchant.create({
    data: { username: 'merchant', passwordHash: await hashPassword('x') },
  });
  merchantToken = signMerchantToken(m.id);
  const c = await prisma.category.create({ data: { name: '主粮', sortOrder: 1 } });
  categoryId = c.id;
});

const auth = () => `Bearer ${merchantToken}`;

describe('商家商品域 API', () => {
  it('未带 token 访问 → 401', async () => {
    const res = await request(app()).get('/api/admin/products');
    expect(res.status).toBe(401);
  });

  it('分类：创建成功 + 重名 409', async () => {
    const ok = await request(app())
      .post('/api/admin/categories')
      .set('Authorization', auth())
      .send({ name: '零食', icon: '🍪' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe('零食');

    const dup = await request(app())
      .post('/api/admin/categories')
      .set('Authorization', auth())
      .send({ name: '零食' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_ITEM');
  });

  it('商品：创建（含2 SKU）→ 详情返回 skus 且价格为分', async () => {
    const created = await request(app())
      .post('/api/admin/products')
      .set('Authorization', auth())
      .send({
        categoryId,
        name: '鸡肉猫粮',
        subtitle: '高蛋白',
        coverImage: 'http://img/1.png',
        skus: [
          { specName: '2kg', price: 9900, stock: 10 },
          { specName: '5kg', price: 19900, stock: 5 },
        ],
      });
    expect(created.status).toBe(200);
    expect(created.body.data.id).toBeGreaterThan(0);

    const detail = await request(app())
      .get(`/api/admin/products/${created.body.data.id}`)
      .set('Authorization', auth());
    expect(detail.status).toBe(200);
    expect(detail.body.data.skus).toHaveLength(2);
    expect(detail.body.data.skus[0].price).toBe(9900);
  });

  it('商品：下架后 status 为 OFF，上架恢复', async () => {
    const created = await request(app())
      .post('/api/admin/products')
      .set('Authorization', auth())
      .send({ categoryId, name: '猫砂', coverImage: 'http://img/2.png', skus: [{ specName: '10L', price: 4500, stock: 3 }] });
    const pid = created.body.data.id;

    const off = await request(app())
      .post(`/api/admin/products/${pid}/off`)
      .set('Authorization', auth());
    expect(off.body.data.status).toBe('OFF');

    const on = await request(app())
      .post(`/api/admin/products/${pid}/on`)
      .set('Authorization', auth());
    expect(on.body.data.status).toBe('ON');
  });

  it('SKU：改价 + 改库存生效', async () => {
    const created = await request(app())
      .post('/api/admin/products')
      .set('Authorization', auth())
      .send({ categoryId, name: '逗猫棒', coverImage: 'http://img/3.png', skus: [{ specName: '单支', price: 1500, stock: 3 }] });
    const skuId = created.body.data.skus[0].id;

    const price = await request(app())
      .put(`/api/admin/skus/${skuId}`)
      .set('Authorization', auth())
      .send({ price: 1800 });
    expect(price.body.data.price).toBe(1800);

    const stock = await request(app())
      .put(`/api/admin/skus/${skuId}/stock`)
      .set('Authorization', auth())
      .send({ stock: 99 });
    expect(stock.body.data.stock).toBe(99);
  });

  it('商品：删除为软删（status=OFF）', async () => {
    const created = await request(app())
      .post('/api/admin/products')
      .set('Authorization', auth())
      .send({ categoryId, name: '狗窝', coverImage: 'http://img/4.png', skus: [{ specName: '大号', price: 15800, stock: 2 }] });
    const pid = created.body.data.id;

    const del = await request(app())
      .delete(`/api/admin/products/${pid}`)
      .set('Authorization', auth());
    expect(del.body.data.status).toBe('OFF');
  });

  describe('编辑商品 SKU（C1 diff-update）', () => {
    it('带 id 的既有 SKU 原位更新（保留库存），新 SKU 追加', async () => {
      const created = await request(app())
        .post('/api/admin/products')
        .set('Authorization', auth())
        .send({
          categoryId,
          name: '鸡肉猫粮',
          coverImage: 'http://img/5.png',
          skus: [
            { specName: '2kg', price: 9900, stock: 10 },
            { specName: '5kg', price: 19900, stock: 5 },
          ],
        });
      const [skuA, skuB] = created.body.data.skus;

      const updated = await request(app())
        .put(`/api/admin/products/${created.body.data.id}`)
        .set('Authorization', auth())
        .send({
          skus: [
            { id: skuA.id, specName: '2kg', price: 10900, stock: 7 },
            { id: skuB.id, specName: '5kg', price: 19900 }, // 不传 stock → 保留原值
            { specName: '10kg', price: 29900, stock: 3 }, // 无 id → 新增
          ],
        });
      expect(updated.status).toBe(200);
      const skus = updated.body.data.skus as { id: number; specName: string; price: number; stock: number }[];
      expect(skus).toHaveLength(3);
      const a = skus.find((s) => s.id === skuA.id)!;
      expect(a.price).toBe(10900);
      expect(a.stock).toBe(7); // 显式传入覆盖
      const b = skus.find((s) => s.id === skuB.id)!;
      expect(b.stock).toBe(5); // 未传 stock 保留原值
      expect(skus.some((s) => s.specName === '10kg')).toBe(true);
      // SKU 行数整体不变（没有全删重建）→ 无残留 id 漂移
      const dbCount = await prisma.sku.count({ where: { productId: created.body.data.id } });
      expect(dbCount).toBe(3);
    });

    it('删除被购物车引用的 SKU → 409 SKU_REFERENCED，且不产生部分更新', async () => {
      const created = await request(app())
        .post('/api/admin/products')
        .set('Authorization', auth())
        .send({
          categoryId,
          name: '猫砂',
          coverImage: 'http://img/6.png',
          skus: [
            { specName: '10L', price: 4500, stock: 3 },
            { specName: '20L', price: 7900, stock: 2 },
          ],
        });
      const [skuA, skuB] = created.body.data.skus;
      // 用户 A 把 10L 加入购物车 → 该 SKU 被引用
      const user = await prisma.user.create({ data: { openid: 'dev-c1-cart' } });
      await prisma.cart.create({ data: { userId: user.id, skuId: skuA.id, quantity: 1 } });

      // 只保留 20L（试图删除被引用的 10L）→ 409
      const res = await request(app())
        .put(`/api/admin/products/${created.body.data.id}`)
        .set('Authorization', auth())
        .send({ skus: [{ id: skuB.id, specName: '20L', price: 7900 }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SKU_REFERENCED');
      // 事务回滚：10L 仍在库
      const skus = await prisma.sku.findMany({ where: { productId: created.body.data.id } });
      expect(skus).toHaveLength(2);
      // 购物车引用原样保留
      const cart = await prisma.cart.findFirst({ where: { userId: user.id } });
      expect(cart!.skuId).toBe(skuA.id);
    });

    it('删除被历史订单引用的 SKU → 409 SKU_REFERENCED', async () => {
      const created = await request(app())
        .post('/api/admin/products')
        .set('Authorization', auth())
        .send({
          categoryId,
          name: '逗猫棒',
          coverImage: 'http://img/7.png',
          skus: [{ specName: '单支', price: 1500, stock: 5 }],
        });
      const skuId = created.body.data.skus[0].id;
      const user = await prisma.user.create({ data: { openid: 'dev-c1-order' } });
      await prisma.order.create({
        data: {
          orderNo: 'NPA0000000000000001',
          userId: user.id,
          totalAmount: 1500,
          addressSnapshot: '{}',
          items: { create: [{ skuId, productId: created.body.data.id, productName: '逗猫棒', specName: '单支', coverImage: 'http://img/7.png', price: 1500, quantity: 1 }] },
        },
      });

      // 用一个新 SKU 替换 → 原 SKU 进入待删除集且被订单引用 → 409
      const res = await request(app())
        .put(`/api/admin/products/${created.body.data.id}`)
        .set('Authorization', auth())
        .send({ skus: [{ specName: '两条装', price: 2800, stock: 5 }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SKU_REFERENCED');
      expect(await prisma.sku.count({ where: { productId: created.body.data.id } })).toBe(1);
    });

    it('删除未被引用的 SKU → 成功移除', async () => {
      const created = await request(app())
        .post('/api/admin/products')
        .set('Authorization', auth())
        .send({
          categoryId,
          name: '狗粮',
          coverImage: 'http://img/8.png',
          skus: [
            { specName: '2kg', price: 9900, stock: 10 },
            { specName: '5kg', price: 19900, stock: 5 },
          ],
        });
      const [skuA, skuB] = created.body.data.skus;
      const res = await request(app())
        .put(`/api/admin/products/${created.body.data.id}`)
        .set('Authorization', auth())
        .send({ skus: [{ id: skuA.id, specName: '2kg', price: 9900 }] });
      expect(res.status).toBe(200);
      expect(res.body.data.skus).toHaveLength(1);
      expect(res.body.data.skus[0].id).toBe(skuA.id);
      expect(await prisma.sku.count({ where: { productId: created.body.data.id } })).toBe(1);
    });
  });
});