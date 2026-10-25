import { prisma } from '../db.js';
import { badRequest, conflict, notFound } from '../utils/HttpError.js';
import type { ProductStatus } from '@prisma/client';

export interface SkuInput {
  specName: string;
  price: number;
  stock?: number;
}

// 编辑场景：既有 SKU 携带 id 走更新，无 id 走新增
export type SkuUpsertInput = SkuInput & { id?: number };

function checkSkuPrice(sku: SkuInput) {
  if (!Number.isInteger(sku.price) || sku.price < 0) {
    throw badRequest('PARAM_ERROR', `SKU ${sku.specName} 价格必须为不小于 0 的整数（分）`);
  }
}

// 冗余最低价：由 SKU 集推导（SKU 价变更的调用方负责同步）
function minPriceOf(skus: SkuInput[]): number {
  return skus.reduce((min, s) => Math.min(min, s.price), Number.MAX_SAFE_INTEGER);
}

export interface ProductInput {
  categoryId: number;
  name: string;
  subtitle?: string;
  description?: string;
  coverImage: string;
  images?: string[];
  skus: SkuInput[];
}

// 事务创建 SPU + SKU
export async function createProduct(data: ProductInput) {
  if (!data.skus.length) throw badRequest('PARAM_ERROR', '至少需要一个规格 SKU');
  const images = JSON.stringify(data.images ?? []);
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        categoryId: data.categoryId,
        name: data.name,
        subtitle: data.subtitle,
        description: data.description,
        coverImage: data.coverImage,
        images,
        minPrice: minPriceOf(data.skus),
      },
    });
    for (const sku of data.skus) {
      checkSkuPrice(sku);
      await tx.sku.create({
        data: { productId: product.id, specName: sku.specName, price: sku.price, stock: sku.stock ?? 0 },
      });
    }
    return tx.product.findUniqueOrThrow({ where: { id: product.id }, include: { skus: true } });
  });
}

export interface ProductQuery {
  categoryId?: number;
  keyword?: string;
  status?: ProductStatus;
  page?: number;
  size?: number;
}

// 商家列表：不过滤状态，支持筛选
export async function listProducts(query: ProductQuery) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 10));
  const where: Record<string, unknown> = {};
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.status) where.status = query.status;
  if (query.keyword) {
    where.OR = [
      { name: { contains: query.keyword } },
      { subtitle: { contains: query.keyword } },
    ];
  }

  const [total, list] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: { skus: { orderBy: { price: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * size,
      take: size,
    }),
  ]);
  return {
    list: list.map((p) => ({
      id: p.id,
      name: p.name,
      subtitle: p.subtitle,
      coverImage: p.coverImage,
      status: p.status,
      salesCount: p.salesCount,
      categoryId: p.categoryId,
      skus: p.skus.map((s) => ({ id: s.id, specName: s.specName, price: s.price, stock: s.stock })),
    })),
    total,
    page,
    size,
  };
}

export async function getProduct(id: number, includeSkus = true) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: includeSkus ? { skus: { orderBy: { price: 'asc' } }, category: true } : undefined,
  });
  if (!product) throw notFound('商品不存在');
  return product;
}

export async function updateProduct(id: number, data: Partial<Omit<ProductInput, 'skus'>> & { skus?: SkuUpsertInput[] }) {
  await getProduct(id, false);
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.update({
      where: { id },
      data: {
        ...(data.categoryId != null ? { categoryId: data.categoryId } : {}),
        ...(data.name != null ? { name: data.name } : {}),
        ...(data.subtitle != null ? { subtitle: data.subtitle } : {}),
        ...(data.description != null ? { description: data.description } : {}),
        ...(data.coverImage != null ? { coverImage: data.coverImage } : {}),
        ...(data.images != null ? { images: JSON.stringify(data.images) } : {}),
      },
    });
    if (data.skus) {
      if (!data.skus.length) throw badRequest('PARAM_ERROR', '至少需要一个规格 SKU');
      const existing = await tx.sku.findMany({ where: { productId: id }, orderBy: { id: 'asc' } });
      const existingById = new Map(existing.map((s) => [s.id, s]));
      const inputIds = new Set(data.skus.filter((s) => s.id != null).map((s) => s.id!));
      for (const s of data.skus) {
        checkSkuPrice(s);
        if (s.id != null && !existingById.has(s.id)) throw badRequest('PARAM_ERROR', `SKU id=${s.id} 不属于该商品`);
      }
      // 被移出的 SKU：若已被购物车/历史订单引用，删除会触外键 → 拒绝并提示保留
      const toDelete = existing.filter((s) => !inputIds.has(s.id)).map((s) => s.id);
      if (toDelete.length) {
        const [cartRefs, orderRefs] = await Promise.all([
          tx.cart.count({ where: { skuId: { in: toDelete } } }),
          tx.orderItem.count({ where: { skuId: { in: toDelete } } }),
        ]);
        if (cartRefs || orderRefs) throw conflict('SKU_REFERENCED', '部分 SKU 已被购物车或历史订单引用，不能删除；请保留该规格或另行停用');
        await tx.sku.deleteMany({ where: { id: { in: toDelete } } });
      }
      // 既有 SKU 原位更新（保留原库存，仅显式传入时覆盖），新 SKU 追加
      for (const s of data.skus) {
        if (s.id != null) {
          await tx.sku.update({
            where: { id: s.id },
            data: { specName: s.specName, price: s.price, ...(s.stock != null ? { stock: s.stock } : {}) },
          });
        } else {
          await tx.sku.create({
            data: { productId: id, specName: s.specName, price: s.price, stock: s.stock ?? 0 },
          });
        }
      }
      // 同步冗余最低价（sort=price 排序键）
      await tx.product.update({ where: { id }, data: { minPrice: minPriceOf(data.skus) } });
    }
    return tx.product.findUniqueOrThrow({ where: { id }, include: { skus: true } });
  });
}

export async function setProductStatus(id: number, status: ProductStatus) {
  await getProduct(id, false);
  return prisma.product.update({ where: { id }, data: { status } });
}

// 软删：下架 + 从 C 端隐藏（status=OFF）
export async function softDeleteProduct(id: number) {
  return setProductStatus(id, 'OFF');
}

export async function updateSku(id: number, data: { specName?: string; price?: number }) {
  const sku = await prisma.sku.findUnique({ where: { id } });
  if (!sku) throw notFound('SKU 不存在');
  if (data.price != null && (!Number.isInteger(data.price) || data.price < 0)) {
    throw badRequest('PARAM_ERROR', '价格必须为不小于 0 的整数（分）');
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.sku.update({
      where: { id },
      data: { ...(data.specName != null ? { specName: data.specName } : {}), ...(data.price != null ? { price: data.price } : {}) },
    });
    // 改价 → 同步该商品冗余最低价
    if (data.price != null) {
      const skus = await tx.sku.findMany({ where: { productId: sku.productId }, select: { price: true } });
      await tx.product.update({
        where: { id: sku.productId },
        data: { minPrice: skus.reduce((m, s) => Math.min(m, s.price), skus[0]?.price ?? 0) },
      });
    }
    return updated;
  });
}

export async function setSkuStock(id: number, stock: number) {
  if (!Number.isInteger(stock) || stock < 0) throw badRequest('PARAM_ERROR', '库存必须为不小于 0 的整数');
  const sku = await prisma.sku.findUnique({ where: { id } });
  if (!sku) throw notFound('SKU 不存在');
  return prisma.sku.update({ where: { id }, data: { stock } });
}

// ---------- C 端公开接口 ----------

export interface PublicProductQuery {
  categoryId?: number;
  keyword?: string;
  sort?: 'price' | 'sales' | 'new';
  page?: number;
  size?: number;
}

// 仅 ON 商品；price 取 SKU 最低价；分页/排序全部下推到 SQL（避免全量载入内存）
export async function listPublicProducts(query: PublicProductQuery) {
  const where: Record<string, unknown> = { status: 'ON' };
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.keyword) {
    where.OR = [{ name: { contains: query.keyword } }, { subtitle: { contains: query.keyword } }];
  }

  const sort = query.sort ?? 'new';
  // 分页/排序全下推 SQL：price 用冗余 minPrice（SQLite 不支持 relation min 排序），均带稳定 tiebreak
  const orderBy =
    sort === 'price'
      ? [{ minPrice: 'asc' as const }, { createdAt: 'desc' as const }]
      : sort === 'sales'
        ? [{ salesCount: 'desc' as const }, { createdAt: 'desc' as const }]
        : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 10));
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy,
      include: { skus: { orderBy: { price: 'asc' } } },
      skip: (page - 1) * size,
      take: size,
    }),
  ]);

  return {
    list: rows.map((p) => ({
      id: p.id,
      name: p.name,
      subtitle: p.subtitle,
      coverImage: p.coverImage,
      price: p.minPrice ?? p.skus[0]?.price ?? 0,
      salesCount: p.salesCount,
      categoryId: p.categoryId,
    })),
    total,
    page,
    size,
  };
}

// C 端详情：OFF 商品对用户视为不存在
export async function getPublicProduct(id: number) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { skus: { orderBy: { price: 'asc' } }, category: true },
  });
  if (!product || product.status !== 'ON') throw notFound('商品不存在或已下架');
  return product;
}

// ---------- 商家 SKU 列表（库存页专用，按 SKU 行分页） ----------

export interface SkuQuery {
  keyword?: string;
  page?: number;
  size?: number;
}

export async function listSkus(query: SkuQuery) {
  const page = Math.max(1, query.page ?? 1);
  const size = Math.min(50, Math.max(1, query.size ?? 10));
  const where: Record<string, unknown> = {};
  if (query.keyword) {
    where.OR = [{ specName: { contains: query.keyword } }, { product: { name: { contains: query.keyword } } }];
  }
  const [total, rows] = await Promise.all([
    prisma.sku.count({ where }),
    prisma.sku.findMany({
      where,
      include: { product: true },
      orderBy: [{ productId: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * size,
      take: size,
    }),
  ]);
  return {
    list: rows.map((s) => ({
      skuId: s.id,
      productId: s.productId,
      productName: s.product.name,
      coverImage: s.product.coverImage,
      specName: s.specName,
      price: s.price,
      stock: s.stock,
      status: s.product.status,
    })),
    total,
    page,
    size,
  };
}