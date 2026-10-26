import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';

beforeEach(async () => {
  await prisma.orderItem.deleteMany();
  // 售后单引用 Order/User，必须先删，否则外键约束会挡住
  await prisma.afterSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();

  const cat = await prisma.category.create({ data: { name: '主粮' } });
  const other = await prisma.category.create({ data: { name: '玩具' } });
  // createdAt 显式拉开 1 分钟：两条种子若落在同一毫秒，sort=new 的 createdAt 排序会退化成
  // 「MySQL 想怎么返回就怎么返回」，断言就会随机失败。
  const older = new Date(Date.now() - 60_000);
  const p1 = await prisma.product.create({ data: { categoryId: cat.id, name: '鸡肉猫粮', subtitle: '高蛋白', coverImage: 'http://img/a.png', status: 'ON', minPrice: 9900, createdAt: older } });
  await prisma.sku.create({ data: { productId: p1.id, specName: '2kg', price: 19900, stock: 5 } });
  await prisma.sku.create({ data: { productId: p1.id, specName: '5kg', price: 9900, stock: 3 } });
  const p2 = await prisma.product.create({ data: { categoryId: other.id, name: '逗猫棒', coverImage: 'http://img/b.png', status: 'ON', minPrice: 1500, createdAt: new Date() } });
  await prisma.sku.create({ data: { productId: p2.id, specName: '单支', price: 1500, stock: 9 } });
  // 下架商品：不得出现在 C 端
  const off = await prisma.product.create({ data: { categoryId: cat.id, name: '下架商品', coverImage: 'http://img/c.png', status: 'OFF', minPrice: 100 } });
  await prisma.sku.create({ data: { productId: off.id, specName: '默认', price: 100, stock: 1 } });
});

const app = () => createApp();

describe('C 端公开商品 API', () => {
  it('列表无需登录 → 200，且只含 ON 商品', async () => {
    const res = await request(app()).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.data.list).toHaveLength(2);
  });

  it('列表返回最低价（分），sort=price 升序', async () => {
    const res = await request(app()).get('/api/products?sort=price');
    const list = res.body.data.list;
    expect(list[0].name).toBe('逗猫棒');
    expect(list[0].price).toBe(1500);
    expect(list[1].price).toBe(9900);
  });

  it('keyword 过滤', async () => {
    const res = await request(app()).get('/api/products?keyword=猫粮');
    expect(res.body.data.list).toHaveLength(1);
    expect(res.body.data.list[0].name).toBe('鸡肉猫粮');
  });

  it('分类过滤', async () => {
    const res = await request(app()).get('/api/products?categoryId=1');
    expect(res.body.data.list.every((p: any) => p.categoryId === 1)).toBe(true);
  });

  it('详情：下架商品 → 404', async () => {
    const off = await prisma.product.findFirst({ where: { status: 'OFF' } });
    const res = await request(app()).get(`/api/products/${off!.id}`);
    expect(res.status).toBe(404);
  });

  it('详情：返回 skus 且价格升序', async () => {
    const on = await prisma.product.findFirst({ where: { name: '鸡肉猫粮' } });
    const res = await request(app()).get(`/api/products/${on!.id}`);
    expect(res.body.data.skus[0].price).toBe(9900);
    expect(res.body.data.skus[1].price).toBe(19900);
  });

  it('GET /api/categories 无需登录且排序稳定', async () => {
    const res = await request(app()).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  // m3：分页下推到 SQL —— total 恒为过滤后总数，跨页不重复
  it('分页：size=1 时每页 total 恒定且两页互补（sort=sales）', async () => {
    const page1 = await request(app()).get('/api/products?sort=sales&page=1&size=1');
    const page2 = await request(app()).get('/api/products?sort=sales&page=2&size=1');
    expect(page1.body.data.total).toBe(2);
    expect(page1.body.data.list).toHaveLength(1);
    expect(page2.body.data.total).toBe(2);
    expect(page2.body.data.list).toHaveLength(1);
    expect(page1.body.data.list[0].id).not.toBe(page2.body.data.list[0].id);
  });

  // m3：默认 sort=new 按创建时间倒序（SQL 排序，非内存反转）
  it('sort=new 最新商品在前', async () => {
    const res = await request(app()).get('/api/products?sort=new');
    const ids = res.body.data.list.map((p: any) => p.id);
    const db = await prisma.product.findMany({ where: { status: 'ON' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    expect(ids).toEqual(db.map((d) => d.id));
  });
});