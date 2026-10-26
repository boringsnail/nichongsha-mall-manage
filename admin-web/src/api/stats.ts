import { api } from './http';

export interface StatsItem {
  gmv: number; // 分
  salesCount: number;
  orderCount: number;
}

export interface Overview {
  today: StatsItem;
  week: StatsItem;
  toShip: number; // 待发货（PAID 未发货）
  lowStockCount: number; // 低库存 SKU 数（库存 ≤10）
}

export interface TopProduct {
  /** 名次，1 开始；后端排好序，前端不用自己算 */
  rank: number;
  productId: number;
  name: string;
  coverImage: string;
  status: 'ON' | 'OFF';
  salesCount: number;
  gmv: number;
  orderCount: number;
}

export interface ProductTrendPoint {
  date: string;
  salesCount: number;
  gmv: number;
  orderCount: number;
}

export interface ProductTrend {
  productId: number;
  name: string;
  coverImage: string;
  status: 'ON' | 'OFF';
  /** 建品以来累计销量，用来和窗口内对比 */
  lifetimeSales: number;
  days: number;
  totalSales: number;
  totalGmv: number;
  orderCount: number;
  points: ProductTrendPoint[];
}

export interface LowStockSku {
  skuId: number;
  productName: string;
  specName: string;
  stock: number;
}

export function adminOverview(): Promise<Overview> {
  return api.get<Overview>('/admin/stats/overview');
}

export function adminTopProducts(params: { days?: number; limit?: number } = {}): Promise<TopProduct[]> {
  return api.get<TopProduct[]>('/admin/stats/top-products', { params });
}

export function adminLowStock(threshold: number = 10): Promise<LowStockSku[]> {
  return api.get<LowStockSku[]>('/admin/stats/low-stock', { params: { threshold } });
}

// ---- 趋势 / 漏斗 / 经营建议（2026-10-11 埋点上线后新增）----

export interface TrendPoint {
  date: string; // yyyy-MM-dd
  gmv: number; // 分
  orderCount: number;
  salesCount: number;
  /** 当天我们付出去的配送成本（分） */
  deliveryCost: number;
  /** 当天发生的退款（分） */
  refund: number;
  /** 净营业额 = gmv − refund − deliveryCost（分） */
  net: number;
}

export interface FunnelStage {
  stage: string;
  label: string;
  value: number; // 去重会话数
  count: number; // 原始事件数
  ratio: number; // 较上一级百分比
  rate: number; // 较首级百分比
}

export interface FunnelData {
  stages: FunnelStage[];
  worst: { from: string; to: string; dropRate: number } | null;
}

export interface Advice {
  level: 'info' | 'warn' | 'danger';
  title: string;
  detail: string;
}

export function adminTrend(days: number = 30): Promise<TrendPoint[]> {
  return api.get<TrendPoint[]>('/admin/stats/trend', { params: { days } });
}

export function adminFunnel(days: number = 30): Promise<FunnelData> {
  return api.get<FunnelData>('/admin/stats/funnel', { params: { days } });
}

export function adminAdvice(days: number = 30): Promise<Advice[]> {
  return api.get<Advice[]>('/admin/stats/advice', { params: { days } });
}

// ---- 营收口径（配送成本上线后新增）----

export interface Revenue {
  days: number;
  /** 总营业额 = 商品 + 顾客付的运费（分） */
  gross: number;
  /** 顾客付的运费（已含在 gross 里） */
  freight: number;
  /** 我们付给骑手/快递的配送成本（分） */
  deliveryCost: number;
  /** 已退款（分） */
  refund: number;
  /** 净营业额 = gross − refund − deliveryCost */
  net: number;
  orderCount: number;
  /** 客单价（分） */
  aov: number;
  /** 净利率（百分比，一位小数） */
  netRate: number;
  /** 还没录配送成本的订单数：不为 0 时净额偏高 */
  missingDeliveryCost: number;
}

export function adminRevenue(days: number = 30): Promise<Revenue> {
  return api.get<Revenue>('/admin/stats/revenue', { params: { days } });
}

// ---- 搜索分析 ----

export interface SearchKeyword {
  keyword: string;
  count: number;
  zeroCount: number;
  lastAt: string;
}

export interface SearchUserRow {
  userId: number;
  nickname: string | null;
  openid: string;
  count: number;
  lastAt: string;
  lastKeyword: string;
}

export interface SearchStats {
  days: number;
  total: number;
  uniqueUsers: number;
  zeroResult: number;
  zeroRate: number;
  topKeywords: SearchKeyword[];
  zeroKeywords: SearchKeyword[];
  trend: { date: string; count: number }[];
  users: SearchUserRow[];
}

export interface SearchLogRow {
  id: number;
  keyword: string;
  resultCount: number;
  createdAt: string;
  user: { id: number | null; nickname: string | null; openid: string };
}

export interface SearchLogPage {
  days: number;
  total: number;
  page: number;
  size: number;
  list: SearchLogRow[];
}

export function adminSearchStats(days: number = 30): Promise<SearchStats> {
  return api.get<SearchStats>('/admin/stats/search', { params: { days } });
}

export function adminSearchLogs(
  params: { days?: number; userId?: number; keyword?: string; page?: number; size?: number } = {}
): Promise<SearchLogPage> {
  return api.get<SearchLogPage>('/admin/stats/search/logs', { params });
}

export function adminProductTrend(productId: number, days: number = 30): Promise<ProductTrend> {
  return api.get<ProductTrend>('/admin/stats/product-trend', { params: { productId, days } });
}
