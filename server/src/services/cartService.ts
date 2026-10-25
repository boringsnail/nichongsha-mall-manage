import { prisma } from '../db.js';
import { badRequest, notFound } from '../utils/HttpError.js';

export const MAX_SKU_QTY = 999;

interface CartItemView {
  id: number;
  skuId: number;
  productId: number;
  name: string;
  coverImage: string;
  specName: string;
  price: number;
  stock: number;
  checked: boolean;
  quantity: number;
}

export interface CartView {
  list: CartItemView[];
  checkedCount: number;
  checkedAmount: number;
}

function checkQty(quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SKU_QTY) {
    throw badRequest('PARAM_ERROR', `数量须为 1~${MAX_SKU_QTY} 的整数`);
  }
}

async function buildView(uid: number): Promise<CartView> {
  const rows = await prisma.cart.findMany({
    where: { userId: uid },
    include: { sku: { include: { product: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const list: CartItemView[] = rows.map((r) => ({
    id: r.id,
    skuId: r.skuId,
    productId: r.sku.productId,
    name: r.sku.product.name,
    coverImage: r.sku.product.coverImage,
    specName: r.sku.specName,
    price: r.sku.price,
    stock: r.sku.stock,
    checked: r.checked,
    quantity: r.quantity,
  }));
  const checked = list.filter((i) => i.checked);
  return {
    list,
    checkedCount: checked.length,
    checkedAmount: checked.reduce((sum, i) => sum + i.price * i.quantity, 0),
  };
}

export async function listCart(uid: number): Promise<CartView> {
  return buildView(uid);
}

export async function addItem(uid: number, skuId: number, quantity: number): Promise<CartView> {
  checkQty(quantity);
  const sku = await prisma.sku.findUnique({ where: { id: skuId } });
  if (!sku) throw notFound('SKU 不存在');

  // 加购时校验 SKU 库存上限，防止超卖
  if (quantity > sku.stock) throw badRequest('PARAM_ERROR', `库存仅剩 ${sku.stock} 件`);

  // 读改写放同一事务：防并发重复加购下数量错乱/超上限
  await prisma.$transaction(async (tx) => {
    const existing = await tx.cart.findUnique({
      where: { userId_skuId: { userId: uid, skuId } },
      select: { id: true, quantity: true },
    });
    if (existing) {
      const next = existing.quantity + quantity;
      if (next > MAX_SKU_QTY) throw badRequest('PARAM_ERROR', `超出单 SKU 数量上限 ${MAX_SKU_QTY}`);
      await tx.cart.update({ where: { id: existing.id }, data: { quantity: next } });
    } else {
      await tx.cart.create({ data: { userId: uid, skuId, quantity } });
    }
  });
  return buildView(uid);
}

export async function updateItem(uid: number, skuId: number, data: { quantity?: number; checked?: boolean }): Promise<CartView> {
  if (data.quantity != null) checkQty(data.quantity);
  const existing = await prisma.cart.findUnique({ where: { userId_skuId: { userId: uid, skuId } } });
  if (!existing) throw notFound('购物车中无此商品');
  await prisma.cart.update({
    where: { id: existing.id },
    data: { ...(data.quantity != null ? { quantity: data.quantity } : {}), ...(data.checked != null ? { checked: data.checked } : {}) },
  });
  return buildView(uid);
}

export async function removeItem(uid: number, skuId: number): Promise<CartView> {
  const existing = await prisma.cart.findUnique({ where: { userId_skuId: { userId: uid, skuId } } });
  if (!existing) throw notFound('购物车中无此商品');
  await prisma.cart.delete({ where: { id: existing.id } });
  return buildView(uid);
}

export async function batchCheck(uid: number, checked: boolean): Promise<CartView> {
  await prisma.cart.updateMany({ where: { userId: uid }, data: { checked } });
  return buildView(uid);
}
