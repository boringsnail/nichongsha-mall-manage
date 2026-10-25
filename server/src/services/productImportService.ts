// 商品批量导入：把外部商品清单（美团商家后台导出 / Excel 整理）批量录入商城。
//
// 行模型：一行 = 一个 SKU；同一「商品名称 + 分类」的多行聚合成一个 SPU。
// 金额：外部表格用「元」，入库统一转「分」（整数）。
import { prisma } from '../db.js';
import { badRequest } from '../utils/HttpError.js';

// 单次导入上限：防止超大文件把进程内存/事务打满
export const IMPORT_MAX_ROWS = 2000;

export type DuplicatePolicy = 'skip' | 'update';

export interface ImportRowInput {
  /** 源表格行号（含表头偏移），仅用于回显定位，缺省按数组序号 */
  rowNo?: number;
  name?: string;
  subtitle?: string;
  categoryName?: string;
  specName?: string;
  price?: string | number;
  stock?: string | number;
  coverImage?: string;
  images?: string;
  description?: string;
}

export interface ImportOptions {
  dryRun: boolean;
  onDuplicate: DuplicatePolicy;
  createMissingCategory: boolean;
  rows: ImportRowInput[];
}

export interface ImportRowError {
  rowNo: number;
  field: string;
  message: string;
}

export interface ImportRowWarning {
  rowNo: number;
  message: string;
}

export type ImportAction = 'CREATE' | 'UPDATE' | 'SKIP' | 'INVALID';

export interface ImportGroupReport {
  name: string;
  categoryName: string;
  skuCount: number;
  action: ImportAction;
  productId?: number;
  newCategory: boolean;
  errors: ImportRowError[];
  warnings: ImportRowWarning[];
}

export interface ImportReport {
  dryRun: boolean;
  committed: boolean;
  summary: {
    totalRows: number;
    productCount: number;
    skuCount: number;
    createCount: number;
    updateCount: number;
    skipCount: number;
    invalidCount: number;
    errorCount: number;
    warningCount: number;
  };
  groups: ImportGroupReport[];
  written: { categories: number; products: number; skus: number; updatedProducts: number };
}

const IMAGE_PLACEHOLDER_PREFIX = 'https://dummyimage.com/400x400/ffd43b/333333&text=';

/** 「元」→「分」。非法输入返回 null（用整数运算避免 39.9*100=3989.999… 的浮点误差） */
export function parseYuanToFen(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/[¥￥\s,，]/g, '');
  if (!s) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [yuan, decimals = ''] = s.split('.');
  return Number(yuan) * 100 + Number(decimals.padEnd(2, '0'));
}

/** 库存：非负整数；空值返回 null（表示「未提供」，与 0 区分） */
export function parseStock(raw: unknown): number | null | 'INVALID' {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/[,，\s]/g, '');
  if (!s) return null;
  if (!/^\d{1,7}$/.test(s)) return 'INVALID';
  return Number(s);
}

function splitImages(raw: unknown): string[] {
  if (raw == null) return [];
  return String(raw)
    .split(/[,，|｜\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s);
}

function asText(raw: unknown): string {
  return raw == null ? '' : String(raw).trim();
}

interface RawSku {
  rowNo: number;
  specName: string;
  price: number; // 分
  stock: number | null;
  stockProvided: boolean;
}

interface ProductGroup {
  name: string;
  categoryName: string;
  /** 该商品首次出现的源表行号，用于「商品级」问题定位 */
  firstRowNo: number;
  subtitle: string;
  description: string;
  coverImage: string;
  images: string[];
  skus: RawSku[];
  errors: ImportRowError[];
  warnings: ImportRowWarning[];
}

/**
 * 校验 + 分组。返回聚合后的商品分组与全局错误。
 * 纯函数，不触碰数据库，便于单测与 dry-run 复用。
 */
export function validateAndGroup(rows: ImportRowInput[]): {
  groups: ProductGroup[];
  errorCount: number;
  warningCount: number;
} {
  const map = new Map<string, ProductGroup>();

  rows.forEach((row, idx) => {
    const rowNo = Number.isInteger(row.rowNo) ? Number(row.rowNo) : idx + 2; // +2：表头占第 1 行
    const name = asText(row.name);
    const categoryName = asText(row.categoryName);

    if (!name) {
      // 没有商品名 → 无法归属，直接算作一个独立错误分组
      const key = `__invalid__${rowNo}`;
      map.set(key, {
        name: '',
        categoryName,
        firstRowNo: rowNo,
        subtitle: '',
        description: '',
        coverImage: '',
        images: [],
        skus: [],
        errors: [{ rowNo, field: 'name', message: '商品名称不能为空' }],
        warnings: [],
      });
      return;
    }

    const key = `${categoryName}\u0000${name}`;
    let group = map.get(key);
    if (!group) {
      group = {
        name,
        categoryName,
        firstRowNo: rowNo,
        subtitle: '',
        description: '',
        coverImage: '',
        images: [],
        skus: [],
        errors: [],
        warnings: [],
      };
      map.set(key, group);
    }

    // ---- 分类 ----
    if (!categoryName) {
      group.errors.push({ rowNo, field: 'categoryName', message: '分类不能为空' });
    } else if (categoryName.length > 20) {
      group.errors.push({ rowNo, field: 'categoryName', message: '分类名称不能超过 20 个字符' });
    }

    // ---- 商品名长度 ----
    if (name.length > 60) {
      group.errors.push({ rowNo, field: 'name', message: '商品名称不能超过 60 个字符' });
    }

    // ---- 商品级字段：取首个非空值，多行不一致时告警 ----
    const subtitle = asText(row.subtitle);
    if (subtitle) {
      if (!group.subtitle) group.subtitle = subtitle;
      else if (group.subtitle !== subtitle) {
        group.warnings.push({ rowNo, message: `副标题与同商品其他行不一致（沿用「${group.subtitle}」）` });
      }
    }

    const description = asText(row.description);
    if (description && !group.description) group.description = description;

    const cover = asText(row.coverImage);
    if (cover) {
      if (!group.coverImage) group.coverImage = cover;
      else if (group.coverImage !== cover) {
        group.warnings.push({ rowNo, message: '封面图与同商品其他行不一致（沿用首行封面图）' });
      }
    }

    const imgs = splitImages(row.images);
    if (imgs.length && !group.images.length) group.images = imgs;

    // ---- SKU ----
    const specName = asText(row.specName);
    if (!specName) {
      group.errors.push({ rowNo, field: 'specName', message: '规格名称不能为空' });
      return;
    }
    if (specName.length > 30) {
      group.errors.push({ rowNo, field: 'specName', message: '规格名称不能超过 30 个字符' });
    }

    const price = parseYuanToFen(row.price);
    if (price == null) {
      group.errors.push({ rowNo, field: 'price', message: `价格「${asText(row.price)}」不是合法金额（元，最多两位小数）` });
      return;
    }

    const stock = parseStock(row.stock);
    if (stock === 'INVALID') {
      group.errors.push({ rowNo, field: 'stock', message: `库存「${asText(row.stock)}」不是非负整数` });
      return;
    }

    if (group.skus.some((s) => s.specName === specName)) {
      group.errors.push({ rowNo, field: 'specName', message: `规格「${specName}」在同一商品内重复` });
      return;
    }

    group.skus.push({
      rowNo,
      specName,
      price,
      stock: stock,
      stockProvided: stock != null,
    });
  });

  const groups = [...map.values()];

  // ---- 商品级兜底校验 ----
  for (const g of groups) {
    if (!g.name) continue;
    if (!g.categoryName) continue; // 已在行级报错
    if (!g.skus.length && !g.errors.length) {
      g.errors.push({ rowNo: g.firstRowNo, field: 'skus', message: '该商品没有任何有效规格' });
    }
    // 封面图占位/保留的决策放到 importProducts（那时才知道是新建还是更新）
  }

  // 同名商品落在多个分类 → 提示（不阻断，按分类各建一个商品）
  const nameToCategories = new Map<string, Set<string>>();
  for (const g of groups) {
    if (!g.name) continue;
    if (!nameToCategories.has(g.name)) nameToCategories.set(g.name, new Set());
    nameToCategories.get(g.name)!.add(g.categoryName);
  }
  for (const g of groups) {
    if (g.name && (nameToCategories.get(g.name)?.size ?? 0) > 1) {
      g.warnings.push({ rowNo: g.firstRowNo, message: `商品名「${g.name}」出现在多个分类，将分别创建` });
    }
  }

  const errorCount = groups.reduce((n, g) => n + g.errors.length, 0);
  const warningCount = groups.reduce((n, g) => n + g.warnings.length, 0);
  return { groups, errorCount, warningCount };
}

/** 执行导入（dryRun=true 只出报告不落库） */
export async function importProducts(opts: ImportOptions): Promise<ImportReport> {
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  if (!rows.length) throw badRequest('PARAM_ERROR', '导入内容为空');
  if (rows.length > IMPORT_MAX_ROWS) {
    throw badRequest('PARAM_ERROR', `单次导入最多 ${IMPORT_MAX_ROWS} 行，当前 ${rows.length} 行`);
  }

  const { groups, errorCount } = validateAndGroup(rows);

  // ---- 分类解析 ----
  // 注意顺序：先把缺失分类建好，后续 CREATE 才能拿到有效 categoryId。
  const categoryNames = [...new Set(groups.map((g) => g.categoryName).filter(Boolean))];
  const existingCategories = await prisma.category.findMany({ where: { name: { in: categoryNames } } });
  const categoryIdByName = new Map(existingCategories.map((c) => [c.name, c.id]));
  // 快照：dry-run 与报告都以此判断「会新建哪些分类」
  const missingCategories = categoryNames.filter((n) => !categoryIdByName.has(n));

  const reports: ImportGroupReport[] = [];
  const written = { categories: 0, products: 0, skus: 0, updatedProducts: 0 };

  if (missingCategories.length && !opts.createMissingCategory) {
    for (const g of groups) {
      if (missingCategories.includes(g.categoryName)) {
        g.errors.push({
          rowNo: g.firstRowNo,
          field: 'categoryName',
          message: `分类「${g.categoryName}」不存在，且未开启自动创建`,
        });
      }
    }
  } else if (missingCategories.length && !opts.dryRun && errorCount === 0) {
    // 只有整批校验通过才落库建分类，避免「导入失败却留下空分类」
    for (const name of missingCategories) {
      const created = await prisma.category.create({ data: { name, sortOrder: 0 } });
      categoryIdByName.set(name, created.id);
      written.categories += 1;
    }
  }

  // ---- 重复商品判定：同分类下同名 ----
  const existingCategoryIds = [...categoryIdByName.values()];
  const existingProducts = existingCategoryIds.length
    ? await prisma.product.findMany({
        where: { categoryId: { in: existingCategoryIds }, name: { in: groups.map((g) => g.name).filter(Boolean) } },
        select: { id: true, categoryId: true, name: true },
      })
    : [];
  const productIdByKey = new Map(existingProducts.map((p) => [`${p.categoryId}\u0000${p.name}`, p.id]));

  for (const g of groups) {
    const hasError = g.errors.length > 0;
    const categoryId = categoryIdByName.get(g.categoryName);
    const existingId = categoryId != null ? productIdByKey.get(`${categoryId}\u0000${g.name}`) : undefined;

    let action: ImportAction = 'INVALID';
    if (hasError) action = 'INVALID';
    else if (existingId == null) action = 'CREATE';
    else action = opts.onDuplicate === 'update' ? 'UPDATE' : 'SKIP';

    // 封面图：新建才落占位图；更新时空封面绝不能用占位图覆盖商品原有封面
    if (!g.coverImage && action === 'CREATE') {
      g.coverImage = IMAGE_PLACEHOLDER_PREFIX + encodeURIComponent(g.name.slice(0, 6));
      g.warnings.push({ rowNo: g.firstRowNo, message: '未填封面图，已使用占位图（可在商品编辑页替换）' });
    } else if (!g.coverImage && action === 'UPDATE') {
      g.warnings.push({ rowNo: g.firstRowNo, message: '未填封面图，将保留商品原有封面图' });
    }

    const report: ImportGroupReport = {
      name: g.name,
      categoryName: g.categoryName,
      skuCount: g.skus.length,
      action,
      productId: existingId,
      newCategory: missingCategories.includes(g.categoryName),
      errors: g.errors,
      warnings: g.warnings,
    };

    // dry-run 或本组有问题 → 不落库
    if (opts.dryRun || action === 'INVALID' || action === 'SKIP') {
      reports.push(report);
      continue;
    }

    try {
      if (action === 'CREATE') {
        const created = await createWithSkus(g, categoryId!);
        report.productId = created;
        written.products += 1;
        written.skus += g.skus.length;
      } else {
        const updated = await updateWithSkus(existingId!, g);
        written.updatedProducts += 1;
        written.skus += updated.newSkus;
        if (updated.warnings.length) report.warnings.push(...updated.warnings);
      }
    } catch (e) {
      report.action = 'INVALID';
      report.errors.push({
        rowNo: g.firstRowNo,
        field: 'database',
        message: e instanceof Error ? e.message : '写入失败',
      });
    }
    reports.push(report);
  }

  const finalErrorCount = reports.reduce((n, r) => n + r.errors.length, 0);
  // 只要还有任何错误行就不算提交成功（错误行已被逐组跳过，不会写入）
  const committed = !opts.dryRun && finalErrorCount === 0;

  return {
    dryRun: opts.dryRun,
    committed,
    summary: {
      totalRows: rows.length,
      productCount: reports.length,
      skuCount: reports.reduce((n, r) => n + r.skuCount, 0),
      createCount: reports.filter((r) => r.action === 'CREATE').length,
      updateCount: reports.filter((r) => r.action === 'UPDATE').length,
      skipCount: reports.filter((r) => r.action === 'SKIP').length,
      invalidCount: reports.filter((r) => r.action === 'INVALID').length,
      errorCount: finalErrorCount,
      warningCount: reports.reduce((n, r) => n + r.warnings.length, 0),
    },
    groups: reports,
    written,
  };
}

async function createWithSkus(g: ProductGroup, categoryId: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        categoryId,
        name: g.name,
        subtitle: g.subtitle || null,
        description: g.description || null,
        coverImage: g.coverImage,
        images: JSON.stringify(g.images),
        minPrice: Math.min(...g.skus.map((s) => s.price)),
      },
    });
    for (const sku of g.skus) {
      await tx.sku.create({
        data: {
          productId: product.id,
          specName: sku.specName,
          price: sku.price,
          stock: sku.stock ?? 0,
        },
      });
    }
    return product.id;
  });
}

/** 覆盖式更新：按规格名匹配既有 SKU（存在→更新价格/库存，缺失→新增）；不删除未出现在表中的规格 */
async function updateWithSkus(
  productId: number,
  g: ProductGroup,
): Promise<{ newSkus: number; warnings: ImportRowWarning[] }> {
  const warnings: ImportRowWarning[] = [];
  return prisma.$transaction(async (tx) => {
    const existing = await tx.sku.findMany({ where: { productId } });
    const bySpec = new Map(existing.map((s) => [s.specName, s]));

    await tx.product.update({
      where: { id: productId },
      data: {
        ...(g.subtitle ? { subtitle: g.subtitle } : {}),
        ...(g.description ? { description: g.description } : {}),
        ...(g.coverImage ? { coverImage: g.coverImage } : {}),
        ...(g.images.length ? { images: JSON.stringify(g.images) } : {}),
      },
    });

    let newSkus = 0;
    for (const sku of g.skus) {
      const hit = bySpec.get(sku.specName);
      if (hit) {
        await tx.sku.update({
          where: { id: hit.id },
          // 表格留空库存 = 保持原库存，避免误清 0
          data: { price: sku.price, ...(sku.stockProvided ? { stock: sku.stock! } : {}) },
        });
      } else {
        await tx.sku.create({
          data: { productId, specName: sku.specName, price: sku.price, stock: sku.stock ?? 0 },
        });
        newSkus += 1;
      }
    }

    const kept = existing.filter((s) => !g.skus.some((k) => k.specName === s.specName));
    if (kept.length) {
      warnings.push({
        rowNo: g.firstRowNo,
        message: `商品保留 ${kept.length} 个表中未出现的规格：${kept.map((s) => s.specName).join('、')}`,
      });
    }

    const allSkus = await tx.sku.findMany({ where: { productId }, select: { price: true } });
    await tx.product.update({
      where: { id: productId },
      data: { minPrice: allSkus.reduce((m, s) => Math.min(m, s.price), allSkus[0]?.price ?? 0) },
    });

    return { newSkus, warnings };
  });
}

/** 供前端「下载模板」使用：标准 CSV 表头 + 示例行 */
export const IMPORT_TEMPLATE_HEADERS = [
  '商品名称',
  '副标题',
  '分类',
  '规格名称',
  '价格(元)',
  '库存',
  '封面图URL',
  '详情图URL(逗号分隔)',
  '商品描述',
] as const;

export const IMPORT_TEMPLATE_SAMPLE: string[][] = [
  ['天然鸡肉猫粮 2kg', '高蛋白养胃鸡肉配方', '主粮/罐头', '2kg/鸡肉', '99', '500', 'https://example.com/a.jpg', 'https://example.com/a1.jpg,https://example.com/a2.jpg', ''],
  ['天然鸡肉猫粮 2kg', '高蛋白养胃鸡肉配方', '主粮/罐头', '2kg/三文鱼', '109', '300', '', '', ''],
  ['猫抓板 瓦楞纸', '耐抓不掉屑 送猫薄荷', '用品/玩具', '标准款', '19', '200', 'https://example.com/b.jpg', '', ''],
];
