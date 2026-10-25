import { api } from './http';

export interface Sku {
  id?: number;
  specName: string;
  /** 价格，单位：分（整数） */
  price: number;
  stock: number;
}

export interface ProductRow {
  id: number;
  name: string;
  subtitle?: string;
  coverImage: string;
  status: 'ON' | 'OFF';
  salesCount: number;
  categoryId: number;
  skus: Sku[];
}

export interface ProductDetail extends Omit<ProductRow, 'skus'> {
  description?: string;
  /** 数据库存 JSON 字符串，接口原样返回，前端自行解析 */
  images: string | string[];
  createdAt?: string;
  skus: Sku[];
}

export interface Page<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

export interface ProductQuery {
  page?: number;
  size?: number;
  keyword?: string;
  status?: 'ON' | 'OFF';
}

export interface ProductInput {
  categoryId: number;
  name: string;
  subtitle?: string;
  description?: string;
  coverImage: string;
  images?: string[];
  skus: Sku[];
}

export function adminListProducts(query: ProductQuery): Promise<Page<ProductRow>> {
  return api.get<Page<ProductRow>>('/admin/products', { params: query });
}

export function adminGetProduct(id: number): Promise<ProductDetail> {
  return api.get<ProductDetail>(`/admin/products/${id}`);
}

/** 库存管理：直接设置 SKU 库存（分页表格用） */
export function adminSetSkuStock(id: number, stock: number): Promise<Sku> {
  return api.put<Sku>(`/admin/skus/${id}/stock`, { stock });
}

export interface StockSku {
  skuId: number;
  productId: number;
  productName: string;
  coverImage: string;
  specName: string;
  price: number;
  stock: number;
  status: 'ON' | 'OFF';
  /** 仅前端保存态标记，不发送 */
  _saving?: boolean;
}

/** 库存管理列表：按 SKU 行分页（total=SKU 数，keyword 匹配商品名/规格名） */
export function adminListSkus(query: { keyword?: string; page?: number; size?: number }): Promise<Page<StockSku>> {
  return api.get<Page<StockSku>>('/admin/skus', { params: query });
}

export function adminCreateProduct(data: ProductInput): Promise<ProductDetail> {
  return api.post<ProductDetail>('/admin/products', data);
}

export function adminUpdateProduct(id: number, data: Partial<ProductInput>): Promise<ProductDetail> {
  return api.put<ProductDetail>(`/admin/products/${id}`, data);
}

export function adminSetProductStatus(id: number, status: 'ON' | 'OFF'): Promise<ProductRow> {
  return api.post<ProductRow>(`/admin/products/${id}/${status === 'ON' ? 'on' : 'off'}`);
}

export function adminDeleteProduct(id: number): Promise<ProductRow> {
  return api.del<ProductRow>(`/admin/products/${id}`);
}

// ---------- 批量导入 ----------

export interface ImportRowInput {
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

export interface ImportPayload {
  dryRun: boolean;
  onDuplicate: 'skip' | 'update';
  createMissingCategory: boolean;
  rows: ImportRowInput[];
}

/** 批量导入：dryRun=true 只做校验预览，不落库 */
export function adminImportProducts(payload: ImportPayload): Promise<ImportReport> {
  // 大批量导入可能超过默认 10s
  return api.post<ImportReport>('/admin/products/import', payload, { timeout: 60000 });
}

export function adminImportTemplate(): Promise<{ headers: string[]; sample: string[][] }> {
  return api.get<{ headers: string[]; sample: string[][] }>('/admin/products/import/template');
}
