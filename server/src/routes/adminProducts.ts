import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  setProductStatus,
  softDeleteProduct,
} from '../services/productService.js';
import {
  importProducts,
  IMPORT_MAX_ROWS,
  IMPORT_TEMPLATE_HEADERS,
  IMPORT_TEMPLATE_SAMPLE,
} from '../services/productImportService.js';

export const adminProductsRouter = Router();

const idParam = validate({ params: z.object({ id: z.coerce.number().int().positive() }) });

const skuSchema = z.object({
  // 编辑时既有 SKU 回传 id → 原位更新（保留购物车/订单引用）；无 id 为新增
  id: z.number().int().positive().optional(),
  specName: z.string().min(1),
  price: z.number().int().min(0),
  stock: z.number().int().min(0).optional(),
});

const createSchema = validate({
  body: z.object({
    categoryId: z.number().int().positive(),
    name: z.string().min(1),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    coverImage: z.string().min(1),
    images: z.array(z.string()).optional(),
    skus: z.array(skuSchema).min(1),
  }),
});

const updateSchema = validate({
  body: z.object({
    categoryId: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    coverImage: z.string().min(1).optional(),
    images: z.array(z.string()).optional(),
    skus: z.array(skuSchema).min(1).optional(),
  }),
});

const listSchema = validate({
  query: z.object({
    categoryId: z.coerce.number().int().positive().optional(),
    keyword: z.string().optional(),
    status: z.enum(['ON', 'OFF']).optional(),
    page: z.coerce.number().int().positive().optional(),
    size: z.coerce.number().int().positive().optional(),
  }),
});

adminProductsRouter.get('/', listSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await listProducts(req.query) });
}));

// ---------- 批量导入 ----------
// 一行 = 一个 SKU；同一「分类 + 商品名称」的多行聚合成一个 SPU。
// dryRun=true 只出校验报告不落库；有错误行时 committed=false（错误行逐组跳过）。

const importRowSchema = z.object({
  rowNo: z.number().int().optional(),
  name: z.string().optional(),
  subtitle: z.string().optional(),
  categoryName: z.string().optional(),
  specName: z.string().optional(),
  // 表格里金额可能是「39.90」这种文本，也可能是数字，统一交给服务层解析
  price: z.union([z.string(), z.number()]).optional(),
  stock: z.union([z.string(), z.number()]).optional(),
  coverImage: z.string().optional(),
  images: z.string().optional(),
  description: z.string().optional(),
});

const importSchema = validate({
  body: z.object({
    dryRun: z.boolean().optional(),
    onDuplicate: z.enum(['skip', 'update']).optional(),
    createMissingCategory: z.boolean().optional(),
    rows: z.array(importRowSchema).min(1).max(IMPORT_MAX_ROWS),
  }),
});

adminProductsRouter.get('/import/template', asyncHandler(async (_req, res) => {
  res.json({ code: 0, data: { headers: IMPORT_TEMPLATE_HEADERS, sample: IMPORT_TEMPLATE_SAMPLE } });
}));

adminProductsRouter.post('/import', importSchema, asyncHandler(async (req, res) => {
  const {
    dryRun = true,
    onDuplicate = 'skip',
    createMissingCategory = true,
    rows,
  } = req.body as {
    dryRun?: boolean;
    onDuplicate?: 'skip' | 'update';
    createMissingCategory?: boolean;
    rows: Record<string, unknown>[];
  };
  res.json({ code: 0, data: await importProducts({ dryRun, onDuplicate, createMissingCategory, rows }) });
}));

adminProductsRouter.post('/', createSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await createProduct(req.body) });
}));

adminProductsRouter.get('/:id', idParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await getProduct(Number(req.params.id)) });
}));

adminProductsRouter.put('/:id', idParam, updateSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await updateProduct(Number(req.params.id), req.body) });
}));

adminProductsRouter.post('/:id/on', idParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await setProductStatus(Number(req.params.id), 'ON') });
}));

adminProductsRouter.post('/:id/off', idParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await setProductStatus(Number(req.params.id), 'OFF') });
}));

// 软删 = 下架
adminProductsRouter.delete('/:id', idParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await softDeleteProduct(Number(req.params.id)) });
}));