import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';
import { parseYuanToFen } from '../services/productImportService';

let merchantToken: string;
let categoryId: number;

const app = () => createApp();
const auth = () => `Bearer ${merchantToken}`;

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
  const c = await prisma.category.create({ data: { name: '主粮/罐头', sortOrder: 1 } });
  categoryId = c.id;
});

function importReq(body: Record<string, unknown>) {
  return request(app()).post('/api/admin/products/import').set('Authorization', auth()).send(body);
}

describe('元 → 分 转换', () => {
  it('整数/一位/两位小数都精确换算（无浮点误差）', () => {
    expect(parseYuanToFen('99')).toBe(9900);
    expect(parseYuanToFen('39.9')).toBe(3990);
    expect(parseYuanToFen('39.90')).toBe(3990);
    expect(parseYuanToFen('0.01')).toBe(1);
    expect(parseYuanToFen(19.9)).toBe(1990);
    // Excel 常见的千分位/货币符号
    expect(parseYuanToFen('¥1,299.00')).toBe(129900);
  });

  it('非法金额返回 null', () => {
    expect(parseYuanToFen('')).toBeNull();
    expect(parseYuanToFen('abc')).toBeNull();
    expect(parseYuanToFen('39.999')).toBeNull();
    expect(parseYuanToFen('-5')).toBeNull();
    expect(parseYuanToFen(undefined)).toBeNull();
  });
});

describe('商品批量导入 API', () => {
  it('未带 token → 401', async () => {
    const res = await request(app()).post('/api/admin/products/import').send({ rows: [] });
    expect(res.status).toBe(401);
  });

  it('dry-run 返回聚合报告但不落库', async () => {
    const res = await importReq({
      dryRun: true,
      rows: [
        { rowNo: 2, name: '天然鸡肉猫粮 2kg', subtitle: '高蛋白', categoryName: '主粮/罐头', specName: '2kg/鸡肉', price: '99', stock: '500', coverImage: 'https://img/a.jpg' },
        { rowNo: 3, name: '天然鸡肉猫粮 2kg', subtitle: '高蛋白', categoryName: '主粮/罐头', specName: '2kg/三文鱼', price: '109', stock: '300' },
        { rowNo: 4, name: '猫抓板', categoryName: '用品/玩具', specName: '标准款', price: '19', stock: '200', coverImage: 'https://img/b.jpg' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data;
    expect(data.dryRun).toBe(true);
    expect(data.committed).toBe(false);
    // 3 行 → 2 个 SPU、3 个 SKU
    expect(data.summary.totalRows).toBe(3);
    expect(data.summary.productCount).toBe(2);
    expect(data.summary.skuCount).toBe(3);
    expect(data.summary.createCount).toBe(2);
    expect(data.summary.errorCount).toBe(0);

    const catFood = data.groups.find((g: { name: string }) => g.name === '天然鸡肉猫粮 2kg');
    expect(catFood.skuCount).toBe(2);
    // 第二行没填封面图 → 沿用首行封面图，不应产生「未填封面图」告警
    expect(catFood.warnings.some((w: { message: string }) => w.message.includes('未填封面图'))).toBe(false);
    // 用品/玩具 分类不存在 → 标记将新建
    const toy = data.groups.find((g: { name: string }) => g.name === '猫抓板');
    expect(toy.newCategory).toBe(true);

    // 关键：dry-run 不能有任何写入
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.sku.count()).toBe(0);
    expect(await prisma.category.count()).toBe(1);
  });

  it('校验错误按行号定位，且有错误时 committed=false 且不写库', async () => {
    const res = await importReq({
      dryRun: false,
      rows: [
        { rowNo: 2, name: '猫粮', categoryName: '主粮/罐头', specName: '2kg', price: '39.999', coverImage: 'https://img/a.jpg' },
        { rowNo: 3, name: '猫粮', categoryName: '主粮/罐头', specName: '2kg', price: '39', coverImage: 'https://img/a.jpg' },
        { rowNo: 4, name: '', categoryName: '主粮/罐头', specName: '1kg', price: '10' },
        { rowNo: 5, name: '狗粮', categoryName: '主粮/罐头', specName: '5kg', price: '88', stock: '-3', coverImage: 'https://img/c.jpg' },
      ],
    });

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.committed).toBe(false);
    expect(data.summary.errorCount).toBeGreaterThan(0);

    const fields = data.groups.flatMap((g: { errors: { rowNo: number; field: string }[] }) => g.errors);
    expect(fields.find((e: { rowNo: number }) => e.rowNo === 2)?.field).toBe('price');
    expect(fields.find((e: { rowNo: number }) => e.rowNo === 5)?.field).toBe('stock');
    expect(fields.some((e: { field: string }) => e.field === 'name')).toBe(true);

    // 有错误行 → 整批不写
    expect(await prisma.product.count()).toBe(0);
  });

  it('提交：元转分入库、minPrice 取最低 SKU、自动创建缺失分类', async () => {
    const res = await importReq({
      dryRun: false,
      onDuplicate: 'skip',
      createMissingCategory: true,
      rows: [
        { name: '天然鸡肉猫粮 2kg', subtitle: '高蛋白', categoryName: '主粮/罐头', specName: '2kg/鸡肉', price: '99', stock: '500', coverImage: 'https://img/a.jpg' },
        { name: '天然鸡肉猫粮 2kg', categoryName: '主粮/罐头', specName: '2kg/三文鱼', price: '109', stock: '300' },
        { name: '猫抓板', categoryName: '用品/玩具', specName: '标准款', price: '19', stock: '200', coverImage: 'https://img/b.jpg' },
      ],
    });

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.committed).toBe(true);
    expect(data.written.products).toBe(2);
    expect(data.written.skus).toBe(3);
    expect(data.written.categories).toBe(1); // 用品/玩具

    const catFood = await prisma.product.findFirstOrThrow({
      where: { categoryId, name: '天然鸡肉猫粮 2kg' },
      include: { skus: { orderBy: { price: 'asc' } } },
    });
    expect(catFood.minPrice).toBe(9900); // 99 元 → 9900 分
    expect(catFood.subtitle).toBe('高蛋白');
    expect(catFood.skus.map((s) => [s.specName, s.price, s.stock])).toEqual([
      ['2kg/鸡肉', 9900, 500],
      ['2kg/三文鱼', 10900, 300],
    ]);
    // 未填封面图的第二行沿用首行 URL
    expect(catFood.coverImage).toBe('https://img/a.jpg');

    const toyCategory = await prisma.category.findUniqueOrThrow({ where: { name: '用品/玩具' } });
    expect(await prisma.product.count({ where: { categoryId: toyCategory.id } })).toBe(1);
  });

  it('重复政策：默认 skip 不动既有商品；update 覆盖价格并按规格名合并', async () => {
    const existing = await prisma.product.create({
      data: {
        categoryId,
        name: '天然鸡肉猫粮 2kg',
        subtitle: '旧副标题',
        coverImage: 'https://img/old.jpg',
        minPrice: 8800,
        skus: { create: [
          { specName: '2kg/鸡肉', price: 8800, stock: 5 },
          { specName: '2kg/旧规格', price: 9900, stock: 7 },
        ] },
      },
      include: { skus: true },
    });
    const oldSpecId = existing.skus.find((s) => s.specName === '2kg/旧规格')!.id;

    // 1) skip
    const skipRes = await importReq({
      dryRun: false,
      onDuplicate: 'skip',
      rows: [{ name: '天然鸡肉猫粮 2kg', subtitle: '新副标题', categoryName: '主粮/罐头', specName: '2kg/鸡肉', price: '120', stock: '1000', coverImage: 'https://img/new.jpg' }],
    });
    expect(skipRes.body.data.summary.skipCount).toBe(1);
    const afterSkip = await prisma.sku.findFirstOrThrow({ where: { productId: existing.id, specName: '2kg/鸡肉' } });
    expect(afterSkip.price).toBe(8800);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: existing.id } })).subtitle).toBe('旧副标题');

    // 2) update
    const updRes = await importReq({
      dryRun: false,
      onDuplicate: 'update',
      rows: [
        { name: '天然鸡肉猫粮 2kg', subtitle: '新副标题', categoryName: '主粮/罐头', specName: '2kg/鸡肉', price: '120', stock: '1000', coverImage: 'https://img/new.jpg' },
        { name: '天然鸡肉猫粮 2kg', categoryName: '主粮/罐头', specName: '2kg/三文鱼', price: '150', coverImage: 'https://img/new.jpg' },
      ],
    });
    expect(updRes.body.data.summary.updateCount).toBe(1);

    const afterUpdate = await prisma.product.findUniqueOrThrow({ where: { id: existing.id }, include: { skus: true } });
    expect(afterUpdate.subtitle).toBe('新副标题');
    expect(afterUpdate.coverImage).toBe('https://img/new.jpg');
    expect(afterUpdate.skus.find((s) => s.specName === '2kg/鸡肉')!.price).toBe(12000);
    expect(afterUpdate.skus.find((s) => s.specName === '2kg/鸡肉')!.stock).toBe(1000);
    // 新增规格
    expect(afterUpdate.skus.find((s) => s.specName === '2kg/三文鱼')!.price).toBe(15000);
    // 表中未出现的规格不删除，只告警
    expect(afterUpdate.skus.some((s) => s.id === oldSpecId)).toBe(true);
    expect(updRes.body.data.groups[0].warnings.some((w: { message: string }) => w.message.includes('2kg/旧规格'))).toBe(true);
    // minPrice 按「全部保留 SKU」重算：保留下来的 2kg/旧规格 99 元仍是最低价
    expect(afterUpdate.minPrice).toBe(9900);
  });

  it('更新时不填封面图 → 保留原封面，不用占位图覆盖（回归）', async () => {
    const existing = await prisma.product.create({
      data: {
        categoryId,
        name: '半封闭猫砂盆',
        coverImage: 'https://img/real-cover.jpg',
        minPrice: 5900,
        skus: { create: [{ specName: '大号', price: 5900, stock: 10 }] },
      },
    });

    const res = await importReq({
      dryRun: false,
      onDuplicate: 'update',
      rows: [{ name: '半封闭猫砂盆', categoryName: '主粮/罐头', specName: '大号', price: '49' }],
    });

    expect(res.body.data.summary.updateCount).toBe(1);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.coverImage).toBe('https://img/real-cover.jpg');
    expect(after.coverImage).not.toContain('dummyimage');
    expect(res.body.data.groups[0].warnings.some((w: { message: string }) => w.message.includes('保留商品原有封面图'))).toBe(true);

    // 价格照常更新，表格留空库存 → 保持原库存
    const sku = await prisma.sku.findFirstOrThrow({ where: { productId: existing.id } });
    expect(sku.price).toBe(4900);
    expect(sku.stock).toBe(10);
  });

  it('新建时不填封面图 → 落占位图并给出告警', async () => {
    const res = await importReq({
      dryRun: true,
      rows: [{ rowNo: 2, name: '全新猫砂盆', categoryName: '主粮/罐头', specName: '大号', price: '59' }],
    });
    const group = res.body.data.groups[0];
    expect(group.errors).toHaveLength(0);
    expect(group.warnings.some((w: { message: string }) => w.message.includes('占位图'))).toBe(true);
  });

  it('关闭自动建分类 → 报分类不存在且不写库', async () => {
    const res = await importReq({
      dryRun: false,
      createMissingCategory: false,
      rows: [{ name: '猫抓板', categoryName: '用品/玩具', specName: '标准款', price: '19', coverImage: 'https://img/b.jpg' }],
    });
    const data = res.body.data;
    expect(data.committed).toBe(false);
    expect(data.groups[0].errors[0].field).toBe('categoryName');
    expect(await prisma.category.count()).toBe(1);
    expect(await prisma.product.count()).toBe(0);
  });

  it('缺少商品名/规格名 → 报错且该组不可写', async () => {
    const res = await importReq({
      dryRun: true,
      rows: [
        { rowNo: 2, name: '', categoryName: '主粮/罐头', specName: '1kg', price: '10' },
        { rowNo: 3, name: '猫粮', categoryName: '主粮/罐头', specName: '', price: '10' },
      ],
    });
    const data = res.body.data;
    const allErrors = data.groups.flatMap((g: { errors: { field: string }[] }) => g.errors);
    expect(allErrors.some((e: { field: string }) => e.field === 'name')).toBe(true);
    expect(allErrors.some((e: { field: string }) => e.field === 'specName')).toBe(true);
    expect(data.summary.invalidCount).toBe(2);
  });

  it('空内容 / 超出单次上限 → 400', async () => {
    const empty = await importReq({ rows: [] });
    expect(empty.status).toBe(400);

    const tooMany = await importReq({
      rows: Array.from({ length: 2001 }, () => ({ name: 'x', categoryName: '主粮/罐头', specName: 'y', price: '1' })),
    });
    expect(tooMany.status).toBe(400);
  });

  it('模板接口返回中文表头与示例行', async () => {
    const res = await request(app()).get('/api/admin/products/import/template').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.data.headers[0]).toBe('商品名称');
    expect(res.body.data.headers).toContain('价格(元)');
    expect(res.body.data.sample.length).toBeGreaterThan(0);
  });
});
