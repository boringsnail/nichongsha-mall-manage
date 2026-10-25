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
  productId: number;
  name: string;
  salesCount: number;
  gmv: number;
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