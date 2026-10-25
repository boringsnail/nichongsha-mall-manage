import { prisma } from '../db.js';
import { conflict, notFound } from '../utils/HttpError.js';

export async function listCategories() {
  return prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
}

export async function createCategory(data: { name: string; icon?: string; sortOrder?: number }) {
  const existing = await prisma.category.findUnique({ where: { name: data.name } });
  if (existing) throw conflict('DUPLICATE_ITEM', '分类名已存在');
  return prisma.category.create({ data });
}

export async function updateCategory(id: number, data: { name?: string; icon?: string; sortOrder?: number }) {
  const exists = await prisma.category.findUnique({ where: { id } });
  if (!exists) throw notFound('分类不存在');
  if (data.name) {
    const dup = await prisma.category.findFirst({ where: { name: data.name, id: { not: id } } });
    if (dup) throw conflict('DUPLICATE_ITEM', '分类名已存在');
  }
  return prisma.category.update({ where: { id }, data });
}

export async function deleteCategory(id: number) {
  const count = await prisma.product.count({ where: { categoryId: id } });
  if (count > 0) throw conflict('CATEGORY_NOT_EMPTY', '该分类下仍有商品，请先移除');
  const exists = await prisma.category.findUnique({ where: { id } });
  if (!exists) throw notFound('分类不存在');
  return prisma.category.delete({ where: { id } });
}