import { api } from './http';

/** 「用户访问」：浏览 / 登录 / 购物车 */

export interface VisitOverview {
  days: number;
  views: {
    pv: number;
    /** 去重访客：登录用户按 userId，游客按 sessionId */
    uv: number;
    productCount: number;
    guestViews: number;
    /** 游客占比（%），越高说明「看的人多、留的人少」 */
    guestRate: number;
  };
  logins: { count: number; users: number; newUsers: number };
  /** 购物车是实时快照，不随时间窗变化 */
  cart: { items: number; users: number; amount: number; stale: number };
}

export interface VisitUserBrief {
  id: number;
  nickname: string | null;
  openid: string;
}

export interface ViewLogRow {
  id: number;
  createdAt: string;
  sessionId: string | null;
  skuId: number | null;
  /** 游客为 null */
  user: VisitUserBrief | null;
  openid: string | null;
  product: { id: number; name: string; coverImage: string; minPrice: number; status: 'ON' | 'OFF' | null } | null;
}

export interface LoginLogRow {
  id: number;
  createdAt: string;
  via: string | null;
  source: string;
  ip: string | null;
  userAgent: string | null;
  isNewUser: boolean;
  openid: string;
  user: VisitUserBrief | null;
}

export interface CartRow {
  id: number;
  quantity: number;
  checked: boolean;
  createdAt: string;
  price: number;
  subtotal: number;
  stock: number;
  skuId: number;
  specName: string;
  product: { id: number; name: string; coverImage: string; status: 'ON' | 'OFF' };
  user: VisitUserBrief;
}

export interface Page<T> {
  total: number;
  page: number;
  size: number;
  list: T[];
}

export function adminVisitOverview(days = 30): Promise<VisitOverview> {
  return api.get<VisitOverview>('/admin/visits/overview', { params: { days } });
}

export function adminViewLogs(params: {
  days?: number;
  userId?: number;
  page?: number;
  size?: number;
} = {}): Promise<Page<ViewLogRow>> {
  return api.get<Page<ViewLogRow>>('/admin/visits/views', { params });
}

export function adminLoginLogs(params: {
  days?: number;
  userId?: number;
  page?: number;
  size?: number;
} = {}): Promise<Page<LoginLogRow>> {
  return api.get<Page<LoginLogRow>>('/admin/visits/logins', { params });
}

/** 购物车是实时快照，没有 days 参数 */
export function adminCarts(params: {
  userId?: number;
  page?: number;
  size?: number;
} = {}): Promise<Page<CartRow> & { totalQuantity: number }> {
  return api.get<Page<CartRow> & { totalQuantity: number }>('/admin/visits/carts', { params });
}
